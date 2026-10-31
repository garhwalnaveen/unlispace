"""Published Python SDK interoperability over a real local HTTP socket."""
import os
import uuid
from s3sdk import S3SDKClient
from s3sdk.patch import Edit

client = S3SDKClient(os.environ["ULS_TEST_ACCESS_KEY"], os.environ["ULS_TEST_SECRET"], endpoint=os.environ["ULS_TEST_ENDPOINT"])
drive, fork = "python-" + uuid.uuid4().hex[:16], "fork-" + uuid.uuid4().hex[:16]
created = client.create_drive(drive, display_name="Python footage", placement="apac")
assert client.describe_drive(drive).drive_id == created.drive_id
first = client.put_object(drive, "old/été.txt", b"abcdef")
assert client.get_object(drive, "old/été.txt").body == b"abcdef"
assert client.read_range(drive, "old/été.txt", 1, 3) == b"bcd"
client.write_at(drive, "old/été.txt", 0, b"A", if_version=first.version_id)
client.patch(drive, "old/été.txt", [Edit(1, b"B")])
client.insert(drive, "old/été.txt", 2, b"!")
client.remove_range(drive, "old/été.txt", 2, 1)
client.truncate(drive, "old/été.txt", 4)
client.rename(drive, "old/été.txt", "new/été.txt")
assert client.get_object(drive, "new/été.txt").body == b"ABcd"
assert client.list_versions(drive, "new/été.txt")[0].version_id == first.version_id
client.restore_version(drive, "new/été.txt", first.version_id)
assert client.get_object(drive, "new/été.txt").body == b"abcdef"
assert client.fork_drive(drive, fork).source_drive_id == created.drive_id
client.put_object(fork, "new/été.txt", b"isolated")
assert client.get_object(drive, "new/été.txt").body == b"abcdef"
client.delete_drive(fork, hard=True)
client.delete_drive(drive, hard=True)
print("PASS published Python SDK: lifecycle, bytes, ranges, edits, rename, history, restore and fork isolation")
