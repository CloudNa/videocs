from range_http_server import RangeRequestHandler


class handler(RangeRequestHandler):
    def do_GET(self):
        self.handle_config_events()

    def do_HEAD(self):
        self.send_error(405, "Config events do not support HEAD")
