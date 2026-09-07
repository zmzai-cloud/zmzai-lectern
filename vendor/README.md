# Local framework attachment build

`zmzai-agent-framework-0.4.1.tgz` is a local build of the sibling
`zmzai-framework` repository with independent input attachments. It is not the
public registry's 0.4.1 package and has not been published.

Build using `pnpm build` then `pnpm pack --pack-destination ../zmzai-lectern/vendor`
in the framework repository. Lectern pins the resulting tarball and its integrity
in pnpm-lock.yaml so clean installs and desktop builds use the attachment code.

Supported inputs: UTF-8 text/code, five files, 512 KiB per file. Binary document
parsing is not implemented; unsupported formats are rejected explicitly.
User text and persistent file parts stay separate. Only the model adapter expands
file bytes into labeled content blocks. Queues and history rebuilding preserve
attachments; rewind resends their stored data.

Verification: framework runner tests capture first and restored model requests,
assert unchanged user text and distinct stored file parts. Binary/size/encoding
validation has dedicated tests. Real-provider and desktop drag/drop acceptance
testing remain outstanding.
