CREATE TRIGGER host_archive_native_guard BEFORE INSERT ON research_control_ops
WHEN NEW.kind = 'native' AND substr(NEW.operation_key, 1, 8) = 'archive:'
 AND EXISTS (
   SELECT 1 FROM research_archives
   WHERE request_id = NEW.request_id AND hash = substr(NEW.operation_key, 9, 64)
     AND file_id = 't4-sha256:' || hash
 )
BEGIN
 SELECT RAISE(ABORT, 'archive_already_received_on_host');
END
