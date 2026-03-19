from range_http_server import RangeRequestHandler


class handler(RangeRequestHandler):
    def do_GET(self):
        self.handle_runtime_config(head_only=False)

    def do_HEAD(self):
        self.handle_runtime_config(head_only=True)
