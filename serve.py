r"""เปิด Onzen Flat Keychain (เวอร์ชันเว็บ) จากเครื่องนี้
ใช้ได้ทั้ง Windows และ Mac:  python serve.py   (Mac: python3 serve.py)
จากนั้นเปิดเบราว์เซอร์ที่ http://localhost:8765
iPad / มือถือที่ต่อ Wi-Fi เดียวกัน เปิดลิงก์ "ในวง Wi-Fi" ที่แสดงตอนรัน"""
import http.server
import os
import socket
import socketserver
import sys
import webbrowser

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
os.chdir(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm',
        '.svg': 'image/svg+xml', '.json': 'application/json', '.html': 'text/html; charset=utf-8',
    }

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

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
    print('ปิดโปรแกรม: กด Ctrl+C หรือปิดหน้าต่างนี้')
    if '--no-browser' not in sys.argv:
        webbrowser.open(f'http://localhost:{PORT}')
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
