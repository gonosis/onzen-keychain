r"""เปิด Onzen Flat Keychain (เวอร์ชันเว็บ) จากเครื่องนี้
ใช้ได้ทั้ง Windows และ Mac:  python serve.py   (Mac: python3 serve.py)
จากนั้นเปิดเบราว์เซอร์ที่ http://localhost:8765
iPad / มือถือที่ต่อ Wi-Fi เดียวกัน เปิดลิงก์ "ในวง Wi-Fi" ที่แสดงตอนรัน

เปิดไว้ระหว่างใช้เว็บ (รวมถึงเว็บบน GitHub) แล้วปุ่ม "ส่งไปที่" จะเปิดไฟล์ใน Bambu Studio / OrcaSlicer
ของเครื่องนี้ได้เลย"""
import glob
import http.server
import json
import os
import re
import socket
import socketserver
import subprocess
import sys
import tempfile
import time
import urllib.parse
import webbrowser

PORT = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 8765
os.chdir(os.path.dirname(os.path.abspath(__file__)))

# Web pages allowed to ask this helper to open a slicer (besides pages served by this server).
ALLOWED_ORIGINS = {'https://gonosis.github.io'}
OUT_DIR = os.path.join(tempfile.gettempdir(), 'OnzenFlatKeychain')

SLICERS = {
    'bambu': {
        'name': 'Bambu Studio',
        'win': [r'%ProgramFiles%\Bambu Studio\bambu-studio.exe', r'%ProgramFiles(x86)%\Bambu Studio\bambu-studio.exe',
                r'%LOCALAPPDATA%\Programs\Bambu Studio\bambu-studio.exe'],
        'win_reg': ('Bambu Studio', 'bambu-studio.exe'),
        'mac': ['/Applications/BambuStudio.app', '/Applications/Bambu Studio.app', '~/Applications/BambuStudio.app'],
    },
    'orca': {
        'name': 'OrcaSlicer',
        'win': [r'%ProgramFiles%\OrcaSlicer\orca-slicer.exe', r'%ProgramFiles(x86)%\OrcaSlicer\orca-slicer.exe',
                r'%LOCALAPPDATA%\Programs\OrcaSlicer\orca-slicer.exe'],
        'win_reg': ('OrcaSlicer', 'orca-slicer.exe'),
        'mac': ['/Applications/OrcaSlicer.app', '~/Applications/OrcaSlicer.app'],
    },
}


def _from_registry(display, exe):
    """Install folder from the Windows uninstall list (for installs outside Program Files)."""
    try:
        import winreg
    except ImportError:
        return None
    roots = [(winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'),
             (winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'),
             (winreg.HKEY_CURRENT_USER, r'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall')]
    for root, path in roots:
        try:
            key = winreg.OpenKey(root, path)
        except OSError:
            continue
        for i in range(winreg.QueryInfoKey(key)[0]):
            try:
                sub = winreg.OpenKey(key, winreg.EnumKey(key, i))
                name = winreg.QueryValueEx(sub, 'DisplayName')[0]
                if display.lower() not in str(name).lower():
                    continue
                for value in ('InstallLocation', 'DisplayIcon'):
                    try:
                        v = str(winreg.QueryValueEx(sub, value)[0]).strip('"').split(',')[0]
                    except OSError:
                        continue
                    cand = v if v.lower().endswith('.exe') else os.path.join(v, exe)
                    if os.path.isfile(cand):
                        return cand
            except OSError:
                continue
    return None


def find_slicer(key):
    s = SLICERS[key]
    if sys.platform == 'win32':
        for p in s['win']:
            p = os.path.expandvars(p)
            if os.path.isfile(p):
                return p
        return _from_registry(*s['win_reg'])
    if sys.platform == 'darwin':
        for p in s['mac']:
            p = os.path.expanduser(p)
            if os.path.isdir(p):
                return p
        return None
    for p in glob.glob(os.path.expanduser('~/Applications/*%s*.AppImage' % s['name'].split()[0])):
        return p
    return None


def open_in(key, path):
    app = find_slicer(key)
    if not app:
        raise RuntimeError(f"ไม่พบ {SLICERS[key]['name']} ในเครื่องนี้")
    if sys.platform == 'darwin':
        subprocess.Popen(['open', '-a', app, path])
    else:
        subprocess.Popen([app, path], close_fds=True)


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm',
        '.svg': 'image/svg+xml', '.json': 'application/json', '.html': 'text/html; charset=utf-8',
        '.otf': 'font/otf', '.ttf': 'font/ttf',
    }

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        origin = self.headers.get('Origin')
        if origin in ALLOWED_ORIGINS:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Access-Control-Allow-Private-Network', 'true')
            self.send_header('Vary', 'Origin')
        super().end_headers()

    def _origin_ok(self):
        origin = self.headers.get('Origin')
        if not origin:
            return True
        host = urllib.parse.urlparse(origin).netloc
        return origin in ALLOWED_ORIGINS or host == self.headers.get('Host')

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Methods', 'GET, POST')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        if self.path.split('?')[0] == '/slicers':
            if not self._origin_ok():
                return self._json(403, {'error': 'origin'})
            return self._json(200, {'host': socket.gethostname(), 'platform': sys.platform,
                                    'slicers': {k: bool(find_slicer(k)) for k in SLICERS}})
        return super().do_GET()

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        if url.path != '/open-in':
            return self._json(404, {'error': 'not found'})
        if not self._origin_ok():
            return self._json(403, {'error': 'origin'})
        q = urllib.parse.parse_qs(url.query)
        key = (q.get('app') or [''])[0]
        name = os.path.basename((q.get('name') or ['keychain.3mf'])[0])
        name = re.sub(r'[\\/:*?"<>|\r\n]+', '_', name) or 'keychain.3mf'
        if key not in SLICERS:
            return self._json(400, {'error': 'unknown app'})
        if not re.search(r'\.(3mf|stl|obj)$', name, re.I):
            return self._json(400, {'error': 'only .3mf / .stl / .obj'})
        length = int(self.headers.get('Content-Length') or 0)
        if not 0 < length <= 200 * 1024 * 1024:
            return self._json(400, {'error': 'bad size'})
        data = self.rfile.read(length)
        os.makedirs(OUT_DIR, exist_ok=True)
        base, ext = os.path.splitext(name)
        path = os.path.join(OUT_DIR, f'{base}_{time.strftime("%H%M%S")}{ext}')
        with open(path, 'wb') as f:
            f.write(data)
        try:
            open_in(key, path)
        except Exception as e:
            return self._json(500, {'error': str(e)})
        return self._json(200, {'ok': True, 'path': path, 'app': SLICERS[key]['name']})

    def log_message(self, *args):
        pass


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('10.255.255.255', 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return None


socketserver.ThreadingTCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(('0.0.0.0', PORT), Handler) as httpd:
    ip = lan_ip()
    print(f'Onzen Flat Keychain (เว็บ) — เครื่องนี้:  http://localhost:{PORT}')
    if ip:
        print(f'                        ในวง Wi-Fi:  http://{ip}:{PORT}   (เปิดบน iPad ได้)')
    found = [s['name'] for k, s in SLICERS.items() if find_slicer(k)]
    print('ส่งไฟล์ไปโปรแกรมสไลซ์ได้: ' + (', '.join(found) if found else '(ไม่พบ Bambu Studio / OrcaSlicer ในเครื่องนี้)'))
    print('ปิดโปรแกรม: กด Ctrl+C หรือปิดหน้าต่างนี้')
    if '--no-browser' not in sys.argv:
        webbrowser.open(f'http://localhost:{PORT}')
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
