"""Public model errors contain safe messages only, never provider response bodies."""


class ModelError(RuntimeError):
    def __init__(self, message, trace=None):
        super().__init__(message)
        self.trace = trace or []
