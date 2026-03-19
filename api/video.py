from range_http_server import RangeRequestHandler


class handler(RangeRequestHandler):
    def do_GET(self):
        self.handle_video_proxy(head_only=False)

    def do_HEAD(self):
        self.handle_video_proxy(head_only=True)
