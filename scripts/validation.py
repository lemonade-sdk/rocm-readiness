"""Structured diagnostics for collection pipeline failures."""


class PipelineValidationError(ValueError):
    def __init__(self, source_id, record, field, reason):
        self.diagnostic = {
            "source_id": source_id,
            "record": record,
            "field": field,
            "reason": reason,
        }
        super().__init__(f"source={source_id} record={record} field={field}: {reason}")
