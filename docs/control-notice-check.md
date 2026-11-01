# Control-channel notice checks

The existing private control channel carries both the request and the Publisher's
thread reply. No new HTTP endpoint, Slack identity or credential is introduced.
`!ai-report publish` continues to publish reports; the opt-in `!ai-notice` outbox
now also accepts a read-only `check` action after a notice has been reserved.

Upload UTF-8 `ai-notice-command.json` using the existing pinned connector identity:

```json
{
  "schema_version": "1.0",
  "command_id": "check-morning-example-01",
  "action": "check",
  "report_request_id": "morning-example-01",
  "bundle_sha256": "<SHA256 of the original report bundle>",
  "attempt_id": "<original reserved attempt>",
  "file_id": "<original reserved Slack file ID>",
  "message_ts": "<existing final message timestamp>"
}
```

The accompanying message remains `!ai-notice submit COMMAND_ID COMMAND_SHA256`.
Use `encodeNoticeCommand` to validate and encode it. The command cannot supply a
destination, expected manifest, command line, claimed image hash or success flag.
The timestamp is an untrusted locator; the checker independently reads the real
message, authenticated sender/App metadata and original file bytes.

The Publisher reuses its saved bundle, publication commit and reservation to
derive the complete expected notice. It revalidates the publication, then invokes
the installed `ai-brief-notice-check` through bounded JSON stdin. The result must
bind the reserved destination, message, file, original byte count and SHA256.
It must report zero sends and no state changes. A negative or unavailable read
returns `verification.slack_status: not_verified`, without raw errors or secrets.
Malformed positive evidence stops before a reply is prepared.

The reply uses the same `!ai-notice receipt` envelope and original command thread.
Its `verification` field contains the checked receipt. `send_authorized` stays
false; the reservation and any prior sender record remain unchanged. The outer
`slack_status` still describes the existing sender report, while `verification`
describes this independent read. Neither is a WeCom delivery receipt. Consumers
must authenticate the Publisher reply and match the original command bytes/hash,
report, attempt and file; rendered text alone is not raw identity evidence.

The response is stored in the existing `notice_commands` table before posting.
A crash or lost acknowledgment requires reading that same thread; it never
reposts the reply or replaces the final file. Repeating a completed command returns
its historical result, not a fresh check. A new check uses a new command ID and
the same original reservation. It grants no new delivery attempt.

## Local execution binding and activation

The private Publisher configuration may include `notification_checker` containing
an absolute `executable` and a fixed `args` array. These are operator configuration,
never fields accepted from Slack. The adapter uses no shell, strips inherited
credentials, limits input/output and runtime, and suppresses subprocess stderr.
The installed checker expects `--root` followed by its existing private relay root.
The invoking identity must already have the reviewed ability to run that reader;
this option does not grant access, copy secrets or change file permissions.

This code does not install that execution binding or enable production notices.
The existing Publisher and relay use separate service identities. Before activation,
confirm an approved local execution path under the reader's identity and test it
without sending. Do not give the Publisher the relay token, Docker/root access or
additional Slack scopes merely to make this command run. The native scheduled
driver's request/reply integration and durable write-intent host remain separate
work; this change does not wire the daily schedule or qualify live PNG upload.

The old PNG probe's two original-file download paths both returned exactly the
source PNG minus its `pHYs` and `tEXt` chunks (58 bytes). No thumbnail was used and
the retained chunks/image data matched. Existing evidence cannot distinguish
connector preprocessing from Slack upload processing. Keep the original-byte
contract; matching pixels do not satisfy it. Any new transport probe must be
explicitly scoped to the private control channel, with no publish command or
formal DM/WeCom delivery, and must separately qualify the intended pre-upload wait.
