"""Public model errors contain safe messages only, never provider response bodies."""


class ModelError(RuntimeError):
    def __init__(self, message, trace=None, http_status=None):
        super().__init__(message)
        self.trace = trace or []
        self.http_status = http_status
