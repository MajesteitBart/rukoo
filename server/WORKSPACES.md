# Workspace protocol proposal

**Status.** The server has the text slice of Gate 1, with direct messages, blocks, signing up with an invitation, deleting a workspace, and reactions, files, link cards and marking unread: [Gate 1 routes](#gate-1-routes) is what it answers today, behind a setting that is off by default. Everything else here is a proposal. Where the first release does less than the proposal, [the first release is lighter](#where-the-first-release-is-lighter) says what and why.

Contract for the workspace server, desktop, Android and agent runner. [Architecture](../docs/workspace-architecture.md) · [Existing account and Book protocol](PROTOCOL.md) · [Optional recovery](WORKSPACE-RECOVERY.md)

## Conventions and compatibility

A **home** is the canonical HTTPS workspace origin and its persistent installation ID. Registry mints the installation ID once and persists it. Pin the routing jurisdiction before creating the first workspace. A jurisdiction migration needs operator-controlled data transfer and cutover. A **credential URL** is the exact normalized v1 account-server URL, including non-default port and case-sensitive base path. A **principal incarnation** is a random immutable ID for one account lifetime. Recovery preserves it; recreation gets a new one. A **grant incarnation** is an immutable logical admission ID for one admission of an actor to a room. Authorization binds this ID together with the restore generation; a restore changes the generation without renumbering logical grants. **Restore generation** changes on import. A **DM generation** closes permanently on loss of participant eligibility. A **runner fence** identifies the one active executor for an installation. A **sequence** orders events inside a conversation and restore generation.

Keep account `protocol: 1` and its existing feature string array. Add `workspaces-v1` and a `workspace` object to `GET /v1/info`. Publish supported wire versions, canonical home, first-party API aliases, optional capabilities (files, runner events, MCP, protected recovery), operator, jurisdiction, actual content/file host, limits, live retention and provider-retained history. Old account clients ignore these fields. If a server lacks workspace support, a new client keeps using its existing features.

Negotiate the highest common workspace version. Unknown fields and explicitly optional informational events can be skipped while advancing the cursor. A required event/semantics change needs a negotiated version or required capability; unsupported consumers stop before applying it and get `upgrade_required` with the minimum supported version. Never silently skip an access change or required erasure.

Use versioned internal Worker-to-Workspace RPC as well. Deploy additive, backward-readable schema changes before enabling new writers. Record the minimum reader/writer versions in the store; tool-assisted rollback or mixed-server traffic that cannot read required data refuses to serve it and leaves data intact. Before advertising `workspaces-v1` or registering the first cleanup reference (including a full member), deploy the incarnation-, cleanup- and class-aware build to every Account, Registry, Book and workspace route and alias. Drain old requests and set this build as the rollback floor. Enable workspace creation and vouchers only after the rollout completes. Do not route account, Book or record requests to pre-class-aware code after that point, including on aliases or gradual rollback. Qualify an N/N−1 rolling deploy and an incompatible rollback in WK-7. Maintain positive, negative and version-skew fixtures for every supported adapter.

Freeze the routes and error vectors Gate 1 exercises before building them: they are in [Gate 1 routes](#gate-1-routes), and the server's tests are their runnable vectors. Before Gate 2, freeze versioned JSON Schema and runnable success/error vectors for the rest, shared by both clients, server and runner. Cover at least `200 {changes:[{conversation:"c7",head:42,read:40,unread:2}],inlineEvents:[{seq:42,kind:"message.posted",message:"m42"}],next:"opaque",more:false}`, send acknowledgement `{operationId,messageId,seq}`, and `{error,message,scope,minVersion?}` with the existing HTTP `Retry-After` header in seconds for throttling.

Reserve file bytes, retained content bytes and open/retained conversation slots against both the workspace and its responsible principal, with lower configurable guest limits. Charge group DM creation to its initiator and keep the slot charged until the retained generation is collected. Show admins aggregate usage by principal, including deleted-principal charges awaiting cleanup. These counters disclose no private room names or bodies.

Gate 1 must demonstrate 401 ended session, non-disclosing 403/404 access denial, 409 stale grant/generation/payload conflict, 410 cursor reset, 413 size/quota, 429 throttle and incompatible-version refusal. Clients must not turn a denial into a retry under another account.

Resources have stable opaque IDs scoped to home, workspace and type. Mint random logical IDs for grants, messages, rooms and files; never reuse them when a restore rewinds numeric sequences. Return generation with a cursor so sequence 101 in two generations cannot be confused. Server-issued cursors bind the principal, workspace and restore generation. Bodies, pages and scans have explicit caps. Authentication expiry asks for login, definitive access denial evicts the affected local state, throttling includes a retry interval, and generation mismatch requires a fresh authorized snapshot.

Use server-enforced token buckets per device and principal for sends, fetches, DM creation, upload reservations and socket upgrades/renewals, plus workspace ceilings and fair per-principal catch-up slots. Return 429 and Retry-After before enqueueing expensive work; enforce limits on raw clients and agents. All of a workspace's traffic shares one object's request queue, and the platform's rate-limit binding counts per location, so the workspace sheds load itself: it answers fetches, history reads, sends and socket tickets with 429 from token buckets it keeps in memory, before any SQL or Account call, at a fraction of its measured capacity. Removals, bans, redactions, departures and revocations bypass those buckets. They are idempotent and clients retry them with backoff, so they still commit during load. A network error grants no authority. Live clients check actual TLS origins and never forward bearer tokens or invite secrets across redirects.

## Accounts and external workspaces

A workspace-only connection never runs personal sync or Book. The protocols below are proposed changes; the existing account server does not yet implement workspaces. Keep the primary account and its jobs at their original address even when the selected workspace changes. Local state is keyed by credential URL, canonical workspace origin, server instance and immutable account incarnation. An instance ID alone proves no trust. A host change or unexpected instance requires confirmation.

For an existing account, sign in at its exact v1 credential URL. A historical first-party alias may serve the same workspace API if both configurations independently name the canonical home, share the instance and explicitly list each other. Check that without credentials; use the saved session only on its original trusted API base. Never rewrite a password proof for a different path. A workspace can borrow its primary account's exact session. Disconnecting a workspace clears only its view, local history, queue and subscription. It never logs out a borrowed primary bearer. Explicit primary sign-out ends dependent workspace access. Explicit external-host sign-out ends all that account's workspace views.

**New external signup.** Generate a random locator such as `w-<random>@workspace.invalid` and a separate random 256-bit password. Use the existing signup crypto and save the pending locator, password, keys and attempt ID in the OS credential store *before* the network call. A lost response or `409 exists` first prompts an ordinary login with the saved credential. On a genuine collision, Registry terminally closes the prior attempt before accepting a new locator. Email is an unverified sign-in name and is never proof that an invite was addressed to a person.

Account persists an account class. Keep voucher-created identities and sessions in class-specific tables absent from the legacy schema. A workspace-only Account object never creates the legacy `account` table. A pre-class-aware server therefore sees no active account and cannot authenticate the guest token for Book or personal sync. Legacy accounts are full accounts. Assign their immutable incarnation atomically on first workspace use. The updated authenticated `GET /v1/account` returns the class and incarnation.

The server derives the account class from its verified enrollment capability. A workspace voucher creates a workspace-only account and cannot authorize full-account signup. Ignore client-supplied class fields. Permit auth, recovery, device management and the workspace API. Deny personal record reads/writes and all Book owner routes in server-side authorization, including handle claims by raw HTTP. Return `403 workspace_account_scope` to a valid workspace-only session, reserving `401` for expired or invalid credentials. Unknown classes fail closed. Only separate operator-approved full-account enrollment can lift the restriction. Joining or leaving a workspace cannot change the class. Ordinary hosted signup caps still apply.

**Finding workspaces.** `GET /v1/workspaces` lists the workspaces a signed-in account belongs to. Account answers it from the references it keeps for cleanup, which are a superset of the memberships, and the client confirms each entry with its Workspace. A second device therefore needs only the sign-in.

**Second device.** Save the host URL, locator, and generated password as ordinary login fields in a password manager; save the account recovery key separately. Importing these fields on a phone performs a normal v1 login and leaves the desktop signed in. A workspace-only account requires no primary Rukoo account. Recovery is for a lost credential: it replaces the password and ends the host's other sessions. If both password and recovery key are lost, create a new incarnation and request fresh admission. No lost DMs or private keys are reassigned by matching a name or address.

**Optional encrypted kit, after the first release.** A password manager covers the first release, and the kit is the only part of this design that touches the encrypted personal record path on desktop, Android and old clients' exports. A full personal account may sync an external connection only with explicit opt-in. Before calling the generic record writer, derive a separate key from the personal data key using the existing HKDF-SHA256 and label `rukoo/v1/workspace-kit`. Seal the connection with the account protocol's versioned AES-256-GCM function and a fresh random 96-bit nonce. Bind envelope version, normalized primary credential URL and a random opaque kit ID as canonical length-prefixed UTF-8 associated data. The outer record is collection `workspacekit`, key = kit ID, value = version and inner ciphertext. The account record then gets its normal outer encryption. Put the target URLs, locator, instance and password **inside** the inner envelope. Omit bearer tokens and recovery keys.

Legacy clients may cache or export the inner ciphertext after opening the outer record.

Updated clients omit the collection from exports, open it transiently only to transfer the plaintext to protected OS storage, and require device unlock and host confirmation for import. No cleartext kit in generic record caches, diagnostics or ordinary exports. Disable kit import where protected storage is unavailable. Removal syncs a sealed tombstone. A prior explicitly saved copy stays usable until its credential is rotated. Before discarding the last local credential make the consequence visible. [Existing personal account behavior](../docs/account.md)

## Invitations and authority

| Action | Who authorizes it |
| --- | --- |
| Create a workspace | Operator-approved creator within host capacity. Its creator is the first owner. |
| Create, discover or join a channel | Full members, including owners/admins, can create a channel within quota. The creator is its first manager. Full members can list and self-join workspace-visible channels. A self-join commits an ordinary grant and ordered activation marker. Guests can see only their admitted channels. Guests and agents require a grant from a manager and cannot create or self-join. Private channels appear only to admitted participants. Visibility is fixed at creation in v1. |
| Rename or archive a channel | A channel manager renames it. A channel manager archives it, and so does a workspace admin for a channel they can see. Archiving is an ordered event: posting stops, history stays readable until retention removes it, and the conversation slot is released when the history is collected. An archived channel stays archived. |
| Invite an owner, member or guest | Owners appoint owners. Owners/admins admit members/guests within their authority. A channel grant is separate. |
| Admit someone to a private channel | An admitted channel manager. For an external guest, the manager requests and a workspace admin co-signs. The same person may hold both roles. A nonparticipant admin sees the manager and “one private channel”; the restricted audit uses opaque IDs. |
| Start a DM | Eligible consenting human participants only. A manager may authorize contact between a guest and a named consenting peer in a shared channel. Cap a group at eight and check eligibility for each pair. *Superseded for the first release:* full members open a DM at once, without consent, and guests are in no DM ([Direct messages](#direct-messages)). |
| Install an agent | An admin approves the installation, one sponsor who is a full workspace member, and eligible channels. Each private manager also approves. The agent's effective scope is its installation scope intersected with the sponsor's current workspace/channel rights and its own grant. V1 agents participate in channels. |
| Moderate and leave | Authors redact their posts. Channel managers can remove posts there. Admins can ban a principal. People may block peers, leave, or report content to the operator. Only owners transfer ownership or close the workspace. *First release:* an owner who is the workspace's only member deletes it, and closing a workspace with other people in it waits ([Workspaces, members and invitations](#workspaces-members-and-invitations)). |

Each person sets their own non-unique display name within the workspace. Names may change. Show the current name and a stable disambiguator within the viewer's permitted directory. Render guest and agent badges from the server-derived actor kind. A departed author appears as a former member and an erased author as a deleted member. Actor IDs keep history and mentions attached to the original incarnation. An agent's sponsor sets its display name within the approved installation.

A block controls direct contact. It closes the affected DM and prevents new DM invitations between the pair. Shared-channel posts and ordinary room updates still reach both participants. Suppress targeted mention notifications and badges from the blocked actor for the blocker. *Superseded for the first release:* a block removes the blocked person's mentions of the blocker, and their posts still count as unread ([Blocks](#blocks)). [The first release is lighter](#where-the-first-release-is-lighter) explains both changes.

Invites are hashed-at-rest, revocable, high-entropy, single-use bearer capabilities, normally valid 24 hours. Put secrets in the fragment, reveal the real host before redemption, then use a POST to the verified home. A bearer link can be forwarded. A named invite binds a principal ID supplied by the intended recipient. A display name, handle or typed email grants nothing. Show who redeemed an invite; restrict directory/profile search to eligible peers. Distinguish agents and guests; keep sign-in locators private. Joining a channel grants access to its retained history. Show that before admitting a person or agent.

*Superseded for the first release:* there are no vouchers. On an invite-only host a sign-up may offer an open workspace invitation in place of the operator's invite code, and each invitation makes one full account ([Signing up with an invitation](#signing-up-with-an-invitation)). The proposal follows.

On an invite-only host, Registry lets authorized admins issue one additional signup voucher within delegated workspace and host budgets. Supply both capabilities in the same link. An existing account skips signup. Closed hosts may require pre-provisioned accounts. Issuance consumes workspace voucher allowance. Reservation atomically holds one global account slot and binds attempt + locator. Account writes the attempt/incarnation alongside signup. On timeout Registry asks Account to **close-or-confirm**: in one transaction Account returns a committed incarnation or persists a terminal fence preventing that attempt from ever committing late. Only confirmed cancellation releases a reserved slot. Refund a never-used voucher once on expiry. A spent voucher cannot be reused even after account deletion.

A workspace invitation records both issuers, grant incarnation, requested role/scope, expiry and optionally the intended principal. At redemption authenticate the recipient at Account, then check both issuers' current roles, their grants and the retirement fence in the workspace transaction. A deleted issuer's account has told the workspace by then, or does so within its retry window. Consume invitation and create membership once. A repeat from the same active principal returns its result; a stale invite can never resurrect a removed grant. Signup can succeed while admission fails (for example, issuer removed). Such an account has zero workspace access. Operators may collect unused synthetic accounts after a disclosed grace period only if no memberships, personal data or pending attempts remain.

## Transactions and identities

One workspace owns a single transactional database. Suggested keys are `conversation(id,kind,generation,head)`, `grant(actor,conversation,incarnation,role,startSeq,readSeq)`, `event(conversation,seq,id,kind)`, an actor/operation uniqueness index, typed mention and thread indexes, attachment manifests and runner checkpoints. The SQL layout can change without changing the wire contract. On Cloudflare Workspace serves one home per object; on PostgreSQL a workspace ID is part of every primary/foreign access key and concurrent mutations use the documented workspace transaction boundary. Scope every query, deep link and action to its workspace, explicitly including diagnostics, exports and local caches.

Derive Workspace routing directly from its logical ID and configured jurisdiction. Registry is off the normal connect, send, sync and file paths; it handles creation, budgets, signup and operator control only. From the basic release onward use one transactional mutation API, classifying every authoritative mutation for fixtures even before protected capture is enabled.

At ingress authenticate the exact session using its authoritative Account object. For compound actions Workspace obtains the immutable principal dependency set, checks it with Account over trusted RPC, then rechecks versions, local roles, sponsor rights, blocks and target in the final Workspace transaction. Proposing, accepting and activating a DM checks all fixed participants with Account. A post to a DM checks its sender at ingress and the local retirement fence: a deleted participant already fails their own authentication on every read, their grants are bound to the old incarnation, and blocks, departures and guest eligibility are local to the workspace. Account pushes a retirement to its workspaces as soon as an account is deleted and retries by alarm. A sponsor deletion must deny the next agent operation even when cleanup has not run, so an agent's operations keep the per-operation sponsor check: that one limits data leaving the workspace. Ordinary channel posts check the sender; each reader proves its own access. Public callers cannot present a role or fabricate an internal admission. Deny on stale state or dependency outage. Limit prechecked Account evidence to a single operation and five seconds: a request already overlapping revocation may finish; a request started after completed deletion must see it.

Commit-time checks in Workspace are synchronous with grant, block and runner-lease changes in that same database. Reauthorize deferred work.

Channel grant activation is atomic with inserting its ordered marker. Use its sequence as the new grant's trigger and initial read position. Prior retained history may be read; earlier mentions never wake a newly admitted agent. Revocation ends that grant incarnation. Re-admission requires a new marker and pending work bound to the former grant cannot post.

A last manager names a willing successor before voluntarily leaving. Forced departure freezes channel management, not messaging. A current participant may request succession using an opaque channel reference; a workspace owner may approve appointment of that consenting, already admitted participant through an audit receipt that reveals no private history or roster. Operators handle orphaned workspace ownership or an empty channel requiring archival. Losing a sole workspace owner freezes **owner-only actions** and permits ordinary messaging under existing grants until audited succession.

*The next two paragraphs are superseded for the first release* by [Direct messages](#direct-messages) and [Blocks](#blocks): there are no proposals and no consent step, and a closed DM is the end of its generation. The table after them says what the first release does instead.

DM consent is explicit. The initiator proposes the exact participant set. Show eligible invitees the list and workspace host; each must accept that set before anyone can post. Decline or expiry closes the proposal. Unblock never counts as consent. Until activation use small expiring proposal rows, not conversation slots. Cap both pending invitations and newly created rooms per initiator (starting defaults: 10 pending, 20 creations per rolling day), reserve workspace capacity at activation, and enforce server-side throttling for retries. A fixed-set invite cannot disclose a private channel name.

A DM has one fixed participant set and generation; enforce uniqueness for an active set. A block, departure or loss of required guest-contact eligibility closes the affected generation atomically, or invalidates an eligibility epoch checked by every send before background closure. Unblocking never reactivates an old generation. Remaining workspace members with prior delivery entitlement (including former guest DM peers) can read/export old delivered history through closure. A workspace ban or departure ends access. Explicitly start a new DM with a new ID and eligible participants. No workspace read path puts messages into the personal MCP tools.

#### Where the first release is lighter

| This proposal asks for | The first release does | Why |
| --- | --- | --- |
| Explicit consent of every DM invitee, proposal rows, expiry | Full members open DMs at once; guests are never in DMs | Full members already see and can mention each other in channels. Blocks and leaving cover unwanted contact. This removes proposals, answers, expiry, a feed flag and request cards on two apps. |
| A manager authorizing guest contact | No guest DMs | Nothing to authorize. Guests talk in channels a manager let them into. |
| Proposing, accepting and activating check every participant with Account | Local member state and the retirement fence | Account pushes `retire()` and retries by alarm; one unreachable Account never blocks the others. |
| A DM generation and eligibility epoch | The closed conversation is the generation; a new DM is a new conversation | One Durable Object serializes every change, and `#post` already refuses an archived conversation in its transaction. |
| Caps on pending invitations and kept DMs per initiator | 20 new DMs per initiator per day, the conversation quota, and deleting a DM that closes empty or that nobody holds | Enough for 100 members. |
| Blocks suppress the blocked actor's badges | Blocks remove mention rows; unread still counts the blocked person's posts | Mentions are what call for attention. Filtering unread would bump every grant of the blocker. |
| A timeline activity row per thread reply, plus followed threads | Reply rows in the main timeline; no follow state | One read position per room stays honest without server changes. |
| A shadow view of the whole cache during a pass | A shadow for room rows only (`pass_room`); a reset deletes cached bodies first | Bodies reload on demand from authorized history. |
| Gap tracking in history | One contiguous range per room | A range that can't be extended cheaply is dropped and reloaded. |
| A cache keyed by credential URL, home, instance and incarnation | One cache file per session, deleted when the session ends | One host in v1, sign-in is rare and a first pass is cheap. |
| Search and preview indexes cleaned by removals | No local search in v1 | Nothing to clean. |
| Signed checkpoints | `409 history_regressed` stops the workspace until Start over | The server issues no checkpoints yet. |
| Workspace-only accounts and signup vouchers | Sign-up accepts a workspace invitation for a full account, once per invitation | The smallest path into a team on an invite-only server. |
| External hosts | One host | Gate 2. |
| Owners closing a workspace | Deleting a workspace whose only member is its owner | Covers the stuck solo owner. Closing a populated workspace waits. |

Account alone owns incarnation cleanup references. Before exposing a membership, durably register the workspace reference with Account; reject registration on a retired incarnation and validate it again when committing membership. Redundant references are safe; remove them only after proving absence of active/pending membership.

On account deletion preserve a retryable incarnation-keyed cleanup outbox, retire the principal and perform existing account deletion locally. Preserve Book's existing cleanup input. On the current schema drop the live `account`, `sessions`, `records`, `meta` and `booking` tables and live extension data; retain only separate cleanup and terminal-attempt receipts without credentials. Presence and `exists()` depend on a live account. Re-signup at the same locator creates empty tables and a new incarnation even while an old cleanup alarm runs.

Before acknowledging cleanup, Workspace atomically marks that exact principal incarnation retired, removes its grants, and invalidates any reservations and pending admissions for it. The final transaction of every in-flight grant, invite, sponsor and DM operation checks this local retirement fence even after a successful Account RPC. Retain the fence at least until every previously issued admission or durable activation attempt is expired or terminal; future attempts require a new live Account check. Workspace acknowledgement or a durable deallocation receipt for its exact incarnation retires a cleanup reference. Account never calls the backup service to change credentials or delete data.

If there are no workspace references or outstanding attempt receipts, keep the existing full deletion path. When cleanup is needed, delete completed references immediately and expire attempt receipts after their external replay window. Perform full storage deletion after the last reference and fence close, only under a fresh local transaction/lifecycle check proving the locator has no newer live incarnation or pending signup; serialize that cleanup with signup. Never delete a newly recreated account.

Alert on unresolved cleanup after 24 hours. Document the list of workspace references an account keeps while it lives, the temporarily retained pseudonymous locator/cleanup metadata, its terminal conditions, and what the operator can infer in the delete dialog, account guide and server privacy disclosure before release. Authored messages are workspace records and follow workspace retention/redaction under a deleted-author label. Say so in the account-delete dialog before destructive action.

## Messaging and sync

| Endpoint, relative to `/v1/workspaces/{id}` | Rule |
| --- | --- |
| `POST /conversations/{c}/messages` | Literal UTF-8 text up to 16 KiB. Structured mentions have typed actor IDs and byte offsets [start,end) on code-point boundaries in the exact original text. Do not normalize. An optional root must be a retained, visible top-level post in the same conversation. At most five finalized attachments can be bound. Reject a structured mention of anyone without a current room grant, including a departed participant or an agent in a DM. An unstructured name in text has no notification semantics. |
| `GET /changes?after=cursor&limit=32&active=c7&roomAfter=40` | A single Workspace transaction returns currently authorized changed rooms, heads, badges, read positions, and optionally up to 20 inline events after 40 capped at that reply's head for c7. Each changed room also carries its retention floor, the lowest sequence still retained, and up to 64 IDs of messages redacted since the cursor, with a flag when there were more. Result includes opaque next cursor and more flag. |
| `GET /conversations/{c}/events?after=41` | Ordered bounded events. Message posted at 42 names author, server time and root. Redaction appends a later event naming the target and immediately suppresses its body/files, including in history and snapshots. |
| `POST /socket-ticket`, then `/socket` | Single-use 30-second ticket delivered by authenticated HTTPS. In native clients send it in an Authorization header during the upgrade, never in a URL. Use a signed ticket (audience, workspace ID, session binding, expiry and random nonce) so stateless ingress rejects invalid requests before routing to Workspace. Inside Workspace, verify its issued ticket record, current authority and nonce and consume the ticket atomically before accepting a socket. Throttle at ingress and bind the accepted connection to that session. On the desktop the socket lives in Electron's main process, because a renderer WebSocket cannot set the header. Where a client cannot set it at all, the ticket travels as a `Sec-WebSocket-Protocol` entry and is consumed the same way. Gate header support on Electron, OkHttp and the website Worker. |
| `POST /conversations/{c}/uploads`, `PUT /uploads/{attempt}/bytes`, `POST /uploads/{attempt}/finalize` | A session or scoped installation reserves a declared size and digest. Transfer requires a one-attempt capability bound to that reservation, actor and deadline. Finalize requires a current session or installation and matching grant. Retry a lost finalize idempotently. |
| `POST /conversations/{c}/attachments/{a}/download` | Return short-lived URL, safe filename, length, digest, type and expiry only for a visible retained message. |
| `GET /conversations/{c}/triggers?grant=G&after=41&limit=32` | Derive installation and trigger filters server-side. Return authorized direct mentions and followed-thread events, scanned-through sequence and continuation, including empty pages. |

A local pending draft records actor, home, room, original grant incarnation and exact payload.

If the local store is at its quota, show unsent state rather than acknowledging an unpersisted operation. On first network attempt, obtain an authenticated server clock reference and allocate a UUIDv7 operation ID. Save it durably *before* sending. Server rejects IDs older than 30 days or more than five minutes ahead even after dedupe cleanup. Keep a minimal result/tombstone until at least the ID's timestamp + 30 days + admission overlap. Atomic append assigns one sequence, binds ready attachments, persists result and a wake intent. Repeat of the exact operation returns the original result; different bytes under the same ID conflict. Show a send as committed only after ack or matching replay.

For `409 submission_expired` or restore-generation mismatch, query the original room for `(actor incarnation, operation ID)` under current access. This unique key stays on the retained message row after the retry receipt expires. Return its stable message ID and current visibility, or an unknown outcome if the post is no longer provable. If unknown, show “Delivery unknown” and ask before a fresh send. Never silently regenerate the operation ID. [UUIDv7](https://www.rfc-editor.org/rfc/rfc9562.html#section-5.7)

A commit appends a change revision in the same workspace transaction. Dispatch empty wake hints after commit only to sockets for which a currently visible room, own read/mention state or previously held grant eviction actually changed. Check grant and session eligibility when dispatching, not just when enqueuing. Never broadcast private activity to the whole workspace; retry durable wake intent by alarm if useful.

Clients resume on startup, after disconnect, on foreground and on a staggered foreground timer (at most 60 seconds on a healthy connection). Hibernating sockets carry an authenticated attachment and a bounded 15-minute lease renewed only by a request that passed fresh Account authentication for that exact human session, or full installation and sponsor validation for that agent. Transport frames and pings never renew it. Invalidation ends authorization even before an empty hint stops. Keep workspace identifiers, message content and unread counts out of wake frames.

Present cached history immediately with its refresh status. Native SQLite stores applied events and delivery cursor atomically. Definite revocation purges inaccessible caches, notifications, pending uploads and queued sends. A disconnected device may keep data until it reconnects.

Use indexed room changes (at most one changed-room entry per atomic batch), targeted member read/mention changes and grant tombstones. For incremental sync, use each actor's authorized grant set and an index on (conversation,revision) to find changed rooms; batch and cap scan work, paging fairly across grants for sparse authorized activity. Avoid an unbounded scan of unrelated private events on each fetch. Compute badges at fetch from visible message/mention sequence indexes after the member's read position, capping display at 99+. Bind cursors to requester and generation and conceal hidden-room revisions. An eviction can identify a room formerly visible, never a new private room.

A cursor that comes with `more: false` certifies every change and eviction its actor may see through its revision. A cursor that comes with `more: true` preserves the unfinished scan: the next page returns what is left, and a room that changes again meanwhile comes back with its newer state. The feed keeps one latest revision per room, grant and eviction and pages them in revision order, so a page boundary never passes a redaction in a room the scan has yet to return.

Return empty continuation pages where needed. Read position is per actor, conversation and grant incarnation, distinct from each device's applied position. Advance monotonically using `max(old, requested)` capped at the authorized head, only over content presented or explicitly marked read. A timeline activity row represents each thread reply. Coalesce dirty read updates to at most one per five seconds per active room; a read elsewhere emits a member-specific change even without new messages.

Return an authenticated checkpoint with the workspace revision and, for a fetched room, its sequence and immutable event ID. A device or runner presents its last checkpoint on resume. Under the same restore generation, an authenticated position ahead of the server, or a different ID at a still-retained position, yields `409 history_regressed` after the applicable access checks. Quarantine the workspace cache and pending sends, suspend runner work and alert the operator. Resume after the documented recovery or new-workspace flow. Treat an aged-out position below the retention floor as a normal reset. A fabricated cursor or bare client claim cannot fence the service. Include a signing key ID in receipts, tickets and installation envelopes. Keep the keys in the host secret store, outside the Workspace database, so losing or rewinding that database does not lose them, and have clients pin the key ID. Retain verification keys for their advertised lifetimes. A position ahead of the server whose receipt can no longer be verified means quarantine, the same as a verified one. An unverifiable receipt on its own asks for reauthentication or a reset.

On ordinary `/changes` pages, apply each changed room's removals in the same local transaction as the cursor update, also for rooms that aren't open. Delete cached events below the room's retention floor, and delete each listed redacted message with its snippets, notifications, previews, cached files and search entries. The rest of the room's cache and its search index stay: a retention sweep or one redaction costs a device only what was removed. When the reply flags more removals than it lists, suppress that room's cached bodies, snippets, notifications and previews as a whole, drop its derived indexes and cached files, and repopulate on demand from authorized history. New posts alone leave existing cached history searchable. A delayed local fetch cannot restore material a later page removed.

On initial join or `410 reset_required`, fetch `/changes` without a cursor and follow `next` until `more` is false. That pass returns every room the actor holds a grant for, in revision order, so a room that changes during the pass comes back again later in it. Build the pass in a shadow view and install it atomically with the final cursor. A room the pass did not return is evicted, and a room whose grant ID differs from the cached one starts with an empty cache. Restart the pass if identity or generation mismatches midway.

When feed continuity is lost, invalidate or quarantine all cached timeline rows, search indexes, notifications and attachment previews in any room whose intervening events cannot be proven complete. Do not display stale bodies as current while rebuilding. Rehydrate only from freshly authorized history that applies current redactions, evict missing records and blobs, and then enable local search/previews. A directory snapshot alone never validates old message content, even when the grant ID is unchanged. This converges without pinning an open SQL transaction across requests.

Page room history under a fixed upper sequence with current redactions/permissions. On an old restore generation reconcile pending sends and surface the local count of missing received IDs *only* after reauthorizing that specific conversation; never display cached contents of removed scopes.

Android foreground/tray behavior follows OS capabilities; WorkManager's periodic interval has a 15-minute minimum and the OS can defer it longer; catch-up is best-effort, no publisher push relay in v1.

## Agents

Install one named, revocable identity in one workspace. Admin approves sponsor and scope, channel managers admit it, and sponsor can issue a ten-minute, one-use enrollment code. Server stores hashed credentials; runner journals proposed secret and rotation ID before preparing a replacement. Idempotent prepare leaves the active credential valid until activation or its 30-day expiry. Proving the saved new secret atomically activates it and retires the old. Disablement revokes both. Sponsor reassignment requires admin approval, new install version, fresh credentials and active channel approvals. Show reduced/suspended access and disclosed downstream providers.

Installation credentials carry a verifiable host-issued envelope (issuer, workspace ID, installation ID, token version, expiry and hash/binding of the random bearer secret). Validate the signature/MAC, expiry and secret binding at stateless ingress before addressing the Workspace. Keep envelope issuance keys in the host secret store. This filters invented installs; inside Workspace still check the stored credential hash, rotation/disable status, sponsor and scope.

Apply cheap host-edge IP limits first, authenticated session/installation budgets at ingress or Account before expensive workspace RPC, and final per-principal fairness at Workspace. Hiding a locator is not an authorization check.

Workspace grants one active runner lease with a monotonically increasing fence. Check lease version, expiration, sponsor admission, grant incarnation and restore generation in **the same transaction** that commits a reply/checkpoint. Replacement and terminal send serialize in this database. An old runner paused after account validation and resumed after takeover cannot commit. A run that finishes after revocation can consume model time but cannot publish.

The reference runner operates beside a **dedicated** Booper/Hermes profile, reachable outbound from the runner. It holds the install secret and trigger-bound read authorization outside model context. Allocate a fresh provider session per trigger chain and discard it at the end. After an uncertain restart use a fresh session with only that trigger's journaled context. Gate the reference profile on a cross-channel canary test that plants a unique private phrase in one channel and verifies an independent profile session never receives or retrieves it in the other. Give this profile no ambient workspace MCP credential, personal tools, unrestricted filesystem/network or cross-session memory. This is an operator qualification requirement, not a claim that the workspace can inspect a remote runtime.

Optional generic MCP uses stateless Streamable HTTP at `/v1/workspaces/{id}/mcp`. It reuses the booking endpoint's dispatcher and its list of protocol versions (`src/mcp.js`), so one server speaks the same MCP versions on both endpoints. Validate the installation bearer on each request. Ship it disabled until its versioned discovery, read and prepare/commit tool schemas and error fixtures pass at Gate 3. The reference runner uses the events API independently. [MCP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

Generic MCP clients use a separate installation that is read-only by default. Use the same data paths and checks as native clients. For optional generic MCP writes, `prepare_post` authorizes and returns a server-minted operation ID bound to the proposed payload, room, installation and grant. This step publishes nothing. A write-capable MCP host must journal the prepared ID before submission and reuse the exact ID and bytes for a retry. A host that cannot persist a write intent receives read-only tools. The model never generates IDs or decides whether to repeat an uncertain write. Server tools list permitted channels, read pages/threads/files, and post or attach only if explicitly granted. [Current integrations](../docs/agents.md)

On mention 42 after activation marker 41, journal the trigger and bounded inputs. The runner fetches its permitted thread/attachments. PDF parsing happens in a constrained process on the agent host; validate type/size and bound parser time, memory and text. Tagged workspace text and filenames are untrusted data. Accept a typed read request, a final reply or `no_reply`. Each non-read result ends the trigger.

The runner can execute up to five allowlisted reads, restricted to the trigger, and request a follow-up **completed Runs API call**, using the exact journaled context with no reliance on provider memory or mid-run injection. Cap the whole trigger at six calls, 64 KiB extracted text and a configurable time budget (initially two minutes). An over-16-KiB final reply may be shortened in one follow-up call within the existing budgets. If it still exceeds the cap or no call remains, record terminal failure without posting partial text. Malformed output, disabled grants and timeouts have explicit failed/no-reply outcomes. Reference mode never gives the model a post tool; only the runner writes its reply.

Process actionable events in order per installation/room. Bind every claim to the current runner fence. Its expiry cannot exceed the executor lease or trigger execution deadline. Takeover revokes the previous claim in the same transaction. Workspace durably records a claim and attempt count per trigger before dispatch to the runtime. Retry the same claim idempotently; count a new attempt only when prior ownership expires without a terminal outcome. After three unsuccessful claims, atomically record terminal failed, advance through that trigger, and notify the sponsor. A late old executor cannot overwrite the outcome.

Workspace schedules unclaimed triggers for expiry, including when the installation has no live runner. A bounded alarm processes due events in room order under the same terminal fence. An expired item uses the same terminal path. For a failed or skipped human mention, append a small optional status event in the source thread visible under its current grants. Publish no prompt or provider error details. A deliberate `no_reply` remains silent. The installation directory shows the last verified lease time to authorized participants. WK-5 crashes the runner three times before it can report, then verifies that a later mention runs.

Persist exact output bytes before submit. Workspace checks the previous authoritative checkpoint and unique trigger/action slot and atomically records a terminal outcome, the reply if any, the optional followed root with expiry (24 hours by default, eligible only for direct human replies to the agent's own post), and the new checkpoint. If a page has two mentions, advance only through the first terminal trigger and preceding non-actionable events; handle the next before claiming its scanned position.

The runner deletes a trigger's journaled inputs, extracted text, output bytes and temporary files when the server confirms a terminal outcome or the runner learns its grant ended. An entry it cannot resolve, for example during an outage, expires after a finite local lifetime, seven days by default. It keeps only the identifiers and spend records it still needs.

A lost acknowledgement or empty local journal resumes at the server checkpoint. Inference may repeat; publication cannot. Limit active model work across the entire installation to two triggers by default, configurable down to one. Fairly schedule rooms by oldest eligible trigger; check current grants, budget and lease on dequeue.

Measure queue age from the source event's server commit time, including runner downtime. Bound queue age (15 minutes by default) and queued item count; preferentially page additional triggers from the durable log when capacity becomes available. For an expired trigger, record a skipped outcome and checkpoint under the same fence without invoking a model. Show the mentioning author why it was skipped.

The runner operator sets finite daily limits on triggers, model calls and token use per installation and per mentioning actor. Reserve the maximum input and output tokens and a call slot in the runner's durable ledger before every provider request. Unknown outcomes consume the reservation. Enforce the installation limit across all actor IDs even if a host forges mentions. An exhausted budget produces a terminal `skipped_budget` outcome. Protect the ledger across restarts and replacement runners; absent trustworthy spend state, require operator re-arm or wait for a new budget period before paid calls.

Keep contiguous room order and never skip an earlier unresolved trigger. A slow run delays later triggers in its own room and may consume one of the installation's bounded slots. Automatic agent-to-agent triggers are off in the first release. Any later opt-in policy requires bounded depth and a separate run budget. No automatic retry of an uncertain external side effect. A retention gap is reported and explicitly resynchronized rather than invoking old history.

## Files

The first release takes a simpler path than the one below: the Worker streams uploads into its file store itself, an R2 bucket or a bucket in an S3-compatible service, and signs download links of its own, on the workspace's address unless `WORKSPACE_FILES_ORIGIN` names another, instead of S3 presigned reads on a separate origin ([Rich messages](#rich-messages)).

Use a separate private workspace bucket on every provider. R2 was the first qualified store, and its tokens scope to buckets, so a dedicated bucket is the only layout there. An S3-compatible bucket is the second: the Worker signs its requests to the service with AWS Signature Version 4, and devices still upload and download only through the Worker. The server's tests run every file flow against an S3 stand-in that checks signatures and digests, and `server/scripts/s3-live-check.mjs` checks a real bucket's signed upload, digest refusal, download, listing and deletion. On such a provider, sharing a bucket with Voice requires independently scoped credentials that the provider enforces for every operation, including listing and deletion. Verify a denied cross-prefix read, write and delete on disposable objects before enabling that layout. [R2 API token permissions](https://developers.cloudflare.com/r2/api/tokens/)

The first Cloudflare path uses a private R2 binding for writes and a restricted S3 credential for signed reads. On VPS configure the internal endpoint separately from an allowlisted public HTTPS download origin. Reuse Voice's provider vocabulary and basic put/get/failure cases; its Rust S3 fake cannot validate signing/checksums or the real bucket. [Voice storage](../voice/README.md#storage)

Desktop, Android and runner enforce their own limits on redirects, response bytes, page counts, filenames and schemas. Accept file downloads only from the exact HTTPS file origin approved for that connection. Use a fresh transport without cookies, account headers or redirects, pin the checked destination for the connection, verify declared size and digest, and treat the filename as data. Reject loopback, link-local and private destinations by default. A local operator may explicitly configure a particular internal file origin and allowed addresses for a private deployment. A remote workspace cannot grant this exception. Test these refusals without reading private services, plus a valid private deployment and a valid public bucket.

1. Within Workspace, authorize the exact actor and grant, reserve declared bytes against the pre-assigned quota, create the upload record and issue upload instructions in one transaction. Cap at 25 MiB per file; cap reservations, temporary bytes and concurrent attempts. No participant can download an unpublished attachment.
2. Stream through the stateless ingress Worker (or VPS HTTP file handler), outside the single workspace writer. Workspace processes only small reserve/finalize/bind transactions. The streaming handler handles length, hashing and bucket I/O. Allocate a fresh random, server-only key per attempt and track it before writing. Verify actual length and SHA-256 via a provider-verified checksum or bounded streaming hash. Reject excess; an ETag cannot stand in for digest validation. Connection budget 30 seconds, then 60 seconds plus declared bytes at 32 KiB/s; abort after 60 seconds of inactivity. A failed v1 upload restarts. Test 25 MiB at the minimum supported sustained rate through the deployed ingress on each advertised provider. Publish only the rate and deadline that pass.
3. Reauthorize finalization after a long transfer. Atomically pin the winning immutable object and mark ready; discard/reclaim losers by tracked key. The uploader can bind the ready attachment once in the same transaction as a post. Expiry and binding serialize. Late finalization cannot revive a closed upload. A terminal attempt releases the user's logical reservation. Charge the declared maximum of each attempt, including competing writers, against a separate finite physical-byte budget before allowing any transfer. A winning attempt converts its charge into live file bytes. Redaction or expiry of a live attachment also retains that physical charge until cleanup confirms deletion. For all other keys, keep the charge until the storage write has reached a known terminal state and the store then confirms deletion. An expired capability stops a new transfer from starting. It says nothing about a write the store already accepted, so an uncertain write stays charged for reconciliation. Durable cleanup retries retain those charges through outages. Publish both limits and refuse new attempts when either budget lacks headroom.
4. Only a visible retained, unredacted message yields a download grant. Return a transferable signed GET valid for at most 60 seconds. Resumption after expiry requires reauthorization; a previously started download can finish. Sanitize names, force download of active types, serve on a separate origin and omit links from logs. Redaction closes future access and creates durable deletion work atomically. The operator's retention policy covers files and backup expiry. [S3 signed URL semantics](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)

## Gate 1 routes

This is what the server answers today when team chat is turned on ([README](README.md#team-chat)). The sections above describe what it grows into. The tests in `test/workspaces.test.js`, `test/workspace-messages.test.js`, `test/workspace-dms.test.js`, `test/workspace-races.test.js`, `test/workspace-live.test.js`, `test/workspace-signup.test.js`, `test/workspace-reactions.test.js`, `test/workspace-reaction-cleared.test.js`, `test/workspace-files.test.js` and `test/workspace-previews.test.js` are the runnable vectors for these routes.

Every route takes the account's session token as `Authorization: Bearer <token>`, like the account API, apart from the file links of [Rich messages](#rich-messages), which carry their own capability. A client names the wire version it speaks in `Rukoo-Workspace-Version`, the highest that it and `versions` in `GET /v1/info` share; a request without one is version 1. Version 2 changes one thing: its reader takes a `message.posted` whose `text` is `''` because the message has only files. A version 1 reader gets such a message with `text` set to `📎 ` and the files' names joined by `, `, and `mentions: []`, in the events of a conversation and the feed's `inlineEvents` alike; what is stored doesn't change. An ID is a letter, an underscore and 22 base64url characters: `w_` for a workspace, `c_` a conversation, `u_` a member, `e_` an event, `g_` a grant, `i_` an invitation and `f_` a file. A member's ID belongs to one workspace, so two workspaces can't tell that they share a person. The account's incarnation is only ever sent to its own devices, in `GET /v1/account`.

`GET /v1/info` lists `workspaces-v1` in `features` and adds:

```json
"workspace": {
  "versions": [1, 2],
  "home": { "origin": "https://rukoo.example", "installation": "…" },
  "capabilities": ["reactions", "unread", "files", "previews"],
  "files": { "maxBytes": 26214400, "workspaceBytes": 5368709120, "origin": "https://rukoo.example" },
  "recovery": "basic",
  "inviteSignups": true,
  "limits": { "workspacesPerAccount": 3, "membershipsPerAccount": 50, "members": 100, "sockets": 200, "conversations": 8192, "textBytes": 16384 },
  "retention": { "contentDays": 90, "feedDays": 14, "platformHistoryDays": 30 }
}
```

`inviteSignups` is true when someone without an account can sign up here with an invitation ([Signing up with an invitation](#signing-up-with-an-invitation)). `capabilities` lists `reactions` and `unread` on every server of this version, `files` only when the operator gave it a file store (an R2 binding or an S3-compatible bucket), and `previews` unless the operator turned link cards off. `files` is there only with the `files` capability: the largest file, the file bytes one workspace may keep, and the origin upload and download links use.

### Errors

An error is `{ "error", "message" }`, with `field` for a refused input, `minVersion` for a refused version, `limit` for the limit a `413` or a `429` hit, and `scope` when the answer tells a device what to let go of: `account` means sign in again, `workspace` and `conversation` mean that thing is gone for this member.

| Status | `error` | Meaning |
| --- | --- | --- |
| 400 | `invalid` | The input named in `field` is wrong. For an upload, `field: size` means the bytes aren't as many as reserved and `field: sha256` that their digest doesn't match. |
| 401 | `unauthorized` | The session ended (`scope: account`), or a socket ticket was refused. |
| 403 | `forbidden`, `cosign_required`, `workspace_limit`, `workspaces_full`, `workspace_account_scope` | The caller's role, or the server's capacity, doesn't allow it. |
| 403 | `dm_unavailable` | With `field: members`: a DM can't be started with these people. One answer for every reason the caller mustn't tell apart ([Direct messages](#direct-messages)). |
| 403 | `files_off` | The server has no file store. Every file route answers this, and so does a post that names files. |
| 404 | `not_found` | With `scope: workspace`: the caller isn't a member, or there is no such workspace. With `scope: conversation`: the caller isn't in it, or there is no such conversation. Each pair gets the same answer. |
| 409 | `operation_conflict`, `submission_expired`, `stale_grant`, `stale_generation`, `archived`, `name_taken`, `last_owner`, `last_manager`, `history_regressed` | The request conflicts with what is there. `archived` is also the answer to a post in a closed DM. |
| 409 | `members_remain` | An owner tried to delete a workspace that has other active members: "Remove everyone else first." |
| 409 | `blocked` | The caller blocked someone in the DM they tried to start. `member` names the first of them. |
| 409 | `reaction_limit` | The message has 20 different emoji already. |
| 409 | `files_unavailable` | A post names an upload that isn't ready, was sent already, expired, is someone else's or is for another conversation. `files` lists them. Nothing was posted. |
| 409 | `invalid_state` | A PUT to an upload that was sent, cancelled, expired or is gone. |
| 410 | `reset_required`, `invite_gone` | The cursor or the invitation can no longer be used. |
| 410 | `expired` | A file link past its time. |
| 413 | `quota` | The workspace is full. `limit` says what ran out: `members` when joining, `conversations` for a new channel or DM, `invites` for open invitations, `bytes` for stored text, `files` for file bytes. |
| 413 | `too_large` | With `limit: fileBytes`: the file is larger than the server takes. |
| 426 | `upgrade_required` | The server doesn't speak this version of the protocol. `minVersion` says which it does. |
| 429 | `rate_limited` | Too many requests. `Retry-After` gives the seconds to wait. `limit: dailyDms` means the caller started 20 DMs in the past day, `limit: uploads` that they hold 20 open uploads, `limit: attempts` that two PUTs to the same upload are under way. |
| 503 | `unavailable` | Deleting a workspace failed because its files couldn't be deleted, or waits for a file that is being uploaded. The workspace is still there; try again after `Retry-After` seconds. |

### Workspaces, members and invitations

Paths below `/v1/workspaces/{id}` are written from there.

| Route | Request and answer |
| --- | --- |
| `GET /v1/workspaces` | → `{ workspaces: [{ id, name, role }] }`: the workspaces this account is a member of, 50 at most (`membershipsPerAccount`). |
| `POST /v1/workspaces` | `{ name, displayName }` → `201 { workspace, me }`. The maker is its owner and manages a first channel, `general`. When the answer gets lost on the way, the server finds out from the workspace itself whether it was made, so its place under the server's limit is never counted twice or left taken. |
| `GET /` | → `{ workspace: { id, name, createdAt, generation, keyId, time, limits, retention }, me }`. `time` is the server's clock, which a device reads before it makes an operation ID. `limits` is `{ members, conversations, textBytes, fileBytes, filesBytes }`. |
| `DELETE /` | → `204`. Deletes the workspace, for an owner who is its only active member: `403 forbidden` for anyone else, `409 members_remain` while someone else is in it. Its files leave the bucket first, while the workspace stays as it is; only then its open invitations stop working, every socket closes with code 4003 and everything else it held goes. The owner's account forgets it, so it no longer counts against `workspacesPerAccount`, and its place under the server's limit is free. Afterwards every route answers the 404 of a workspace that doesn't exist, and so does a join that was under way when it went. While a file of the workspace is being uploaded, and when the bucket fails, the answer is `503 unavailable` with `Retry-After: 30`, and the workspace stays as it was, apart from files already deleted, for the owner to try again. |
| `GET /members` | → `{ members: [{ id, kind, name, role, state, joinedAt }], more }`. `role` is `owner`, `admin`, `member` or `guest`; `state` is `active`, `left`, `removed` or `deleted`. A full member gets everyone who is active and the 1,000 who left most recently; `more` says there were others. A guest gets the active members of the channels they are in. |
| `PATCH /members/me` | `{ name }` → `{ me }`. |
| `PATCH /members/{u}` | `{ role }` → `{ member }`. Owners change anyone. Admins move people between `member` and `guest`. |
| `DELETE /members/{u}`, `DELETE /members/me` | → `204`. Removing someone, or leaving. Every grant ends, and so do the invitations they issued. Someone who is the only manager of channels other people are in appoints a manager in each before leaving: `409 last_manager` lists them as `channels`. A channel whose last member goes is archived. The account keeps a note that it was a member, so the workspace still hears when that account is deleted and takes the name off what it wrote. |
| `POST /invites` | `{ role, channels?, expiresIn? }` → `201 { invite: { id, role, channels, channelCount, issuer, createdAt, expiresAt }, secret }`. `role` is `member` or `guest`, `channels` are channels the issuer manages, `expiresIn` is in seconds: 24 hours unless given, seven days at most. The secret is shown once; the server keeps its hash. A channel its issuer stops managing drops out of the invitation, and managing it again doesn't bring it back. |
| `GET /invites`, `DELETE /invites/{i}` | The open invitations, and withdrawing one. `channels` lists the channels the caller can see and `channelCount` says how many the invitation leads into right now, without the ones that were archived since and, for a `member` invitation, with the default channel. `POST /invites` answers the same way. An admin outside a private channel so learns that there is one, not which. |
| `POST /invites/preview` | `{ invite }` → `{ workspace: { id, name }, role, channels, issuer: { name }, expiresAt }`, for any signed-in account, to show before joining. `channels` is a count of the channels joining leads into, the default channel of a `member` invitation included. |
| `POST /join` | `{ invite, name }` → `201 { workspace, me }`, or `200` for someone who already is a member. An invitation works once. A `member` invitation also lets the new member into the workspace's default channel: its oldest channel that is open and that the workspace can see, normally `general`. The `member.joined` there names the member as actor, as a join of their own does. A `guest` invitation leads only into the channels it names. |

An invitation link carries the host, the workspace ID and the secret, the last two in the fragment. A wrong secret gets the 404 of a workspace that doesn't exist. A used, withdrawn or expired one gets `410 invite_gone`, and so does one whose issuer left or is no longer an owner or admin.

#### Invitation links and the join page

An invitation link is `<credential URL>/join#w=<workspace>&i=<secret>`, where the credential URL is the address of the server the account signs in at. The fragment never leaves the browser. Opened in a browser, `GET /join` answers a page in English or Dutch that says the link is an invitation to a workspace on this server, names the operator and gives the steps: install Rukoo, then paste the page's address into Chat's Join dialog, or, for someone without an account, into the invite code field of the sign-up form ([PROTOCOL.md](PROTOCOL.md#get-join)). The page runs no script and sends no referrer. The apps don't open these links themselves yet.

#### Signing up with an invitation

On a server whose sign-ups need an invite code, an open invitation stands in for one: `POST /v1/signup` takes `workspaceInvite: { workspace, invite }` when `invite` is missing or wrong ([PROTOCOL.md](PROTOCOL.md#post-v1signup)). Each invitation makes one full account, counted by the registry like an invite code with one use, within `MAX_ACCOUNTS`. Signing up doesn't use the invitation; the new account joins with it as anyone does. An invitation that is used, withdrawn or expired, or whose issuer can no longer invite, gets `403 invite_required`, as a wrong code does. The operator turns this off with `WORKSPACE_SIGNUPS=off`, which keeps sign-ups to their own codes, and `inviteSignups` in `GET /v1/info` says which applies.

### Channels

| Route | Request and answer |
| --- | --- |
| `GET /channels` | → `{ channels: [{ id, name, visibility, archived, joined, role, members }] }`. `visibility` is `workspace` or `private`; `role` is the caller's `manager` or `member`, or null. A full member gets every channel they are in and every channel the workspace can see. A guest gets the channels they are in. It lists channels only, never a DM. |
| `POST /channels` | `{ name, visibility }` → `201 { channel }`. Full members only. Names are unique among the channels the workspace can see. |
| `PATCH /channels/{c}` | `{ name }` renames, for a manager. `{ archived: true }` archives, for a manager or for an admin who can see the channel. → `{ channel }`. |
| `POST /channels/{c}/join` | → `{ channel }`. A full member lets themselves into a channel the workspace can see. |
| `GET /channels/{c}/members` | → `{ members: [{ member, role }] }`. |
| `POST /channels/{c}/members` | `{ member }` → `{ member, role }`. A manager lets a member in. For a guest that manager must also be an owner or admin. |
| `PATCH /channels/{c}/members/{u}` | `{ role }`, for a manager. |
| `DELETE /channels/{c}/members/{u}`, `…/me` | → `204`. A manager takes someone out, or the caller leaves. The last manager passes the channel on with `?successor={u}`. The last person to leave archives it. |

Every channel route answers a DM's ID with the 404 of a conversation that doesn't exist, also to someone in the DM: renaming, archiving, joining, the member routes, and a DM's ID in the `channels` of `POST /invites`.

### Direct messages

A DM is a conversation of `kind: dm` between 2 and 8 full members (owners, admins and members), the one who starts it included. Guests can't start a DM and can't be in one; they talk in channels. Messages, threads, mentions, reads, removals, the feed, sockets and retention work in a DM as in a channel.

- One open DM exists per exact set of people. Starting a set that has an open DM answers that DM, whoever started it.
- A DM opens at once, with one `dm.started` event at sequence 1. Every participant's grant, with role `member`, starts there, and so does their read position.
- A DM closes and never opens again. The feed row says why in `closedReason`: `left` when someone's grant ended (they left the DM, left or were removed from the workspace, or their account was deleted), `ineligible` when someone became a guest, `closed` when one participant blocked another. Everyone who still holds it keeps reading it, and authors can still remove their messages. Retention collects it like an archived channel. Starting the same set again makes a new DM with a new ID.
- A DM that closes before anyone posted a message in it, or that nobody holds any more, is deleted at once. Whoever still held it gets an eviction, and its conversation slot is free again.
- Mentions in a DM name its participants. Only a message's author removes it, because nobody manages a DM. A post to a closed DM gets `409 archived` with the message "This conversation is closed.", after the check for a retry, so a message that committed before the close still gets its first answer.

| Route | Request and answer |
| --- | --- |
| `POST /dms` | `{ members }`: the other people, 1 to 7 member IDs, each once. → `201 { dm }` for a new DM, `200 { dm }` for the open DM of this set, which costs nothing against the limits. `dm` is the DM's feed row as the caller sees it ([The feed](#the-feed)), with `removed: []`. A retry after a lost answer finds the same DM through its set, so the route takes no operation ID. |
| `POST /dms/{c}/leave` | → `204`. The caller's grant ends: their devices get an eviction, the others see `member.left`, and the DM closes for them with `left`. Leaving a closed DM only ends the caller's grant, which takes it off their list. A conversation the caller isn't in, and a channel, get `404 not_found` with `scope: conversation`. |

`POST /dms` checks in this order, in one transaction, because the order keeps a refusal from saying more than the caller's own blocks:

| Order | Answer | When |
| --- | --- | --- |
| 1 | `400 invalid`, `field: members` | The list isn't 1 to 7 different member IDs, or it names the caller. |
| 2 | `403 dm_unavailable`, `field: members` | The caller is a guest, an ID isn't an active member, or someone in the set is a guest. |
| 3 | `200 { dm }` | The set has an open DM. |
| 4 | `409 blocked`, `member` | The caller blocked someone in the set. `member` is the first of them, in the set's order. |
| 5 | `403 dm_unavailable` | Someone in the set blocked the caller, or two others in it blocked one another. The same body as order 2. |
| 6 | `429 rate_limited`, `limit: dailyDms` | The caller started 20 DMs in the past 24 hours. `Retry-After` is the seconds until the oldest of those is a day old. |
| 7 | `413 quota`, `limit: conversations` | The workspace has no conversation slot left. DMs count against `conversations` like channels. |

The Worker checks the list's shape first. Before the transaction, starting a DM then draws from its own allowance ([Limits on requests](#limits-on-requests)), which answers `429 rate_limited` with `scope: workspace`, and a caller who isn't a member gets the workspace's 404, as on every route.

### Blocks

| Route | Request and answer |
| --- | --- |
| `GET /blocks` | → `{ blocks: [{ member, at }] }`: the caller's own blocks, newest first. |
| `POST /blocks` | `{ member }` → `201 { block: { member, at } }` for a new block, `200` with the same body when it was there already. `400 invalid` with `field: member` for a malformed ID or the caller's own. `404 not_found`, without a scope, when the ID isn't an active member the caller can see: a full member sees every active member, a guest the people they share a room with. An ID nobody has gets the same answer. |
| `DELETE /blocks/{u}` | → `204`, also when there was no block. |

A block, in the transaction that makes it:

1. closes every open DM that has both people in it, with `closed`;
2. refuses new DMs that would have both, whoever starts them ([Direct messages](#direct-messages));
3. deletes the blocker's mentions in messages the blocked person wrote, so each room where one went comes back in the blocker's feed with its `mentions` put right;
4. stops the blocked person's later mentions of the blocker from counting;
5. sets `directory.blocks` in the blocker's feed, and wakes the blocker's devices. Unblocking does the same.

The blocked person's posts stay visible in shared channels and still count as unread. Unblocking takes the block away and nothing else: closed DMs stay closed, and mentions that went stay gone. Nobody is told about a block. The blocked person can infer one when a one-to-one DM closes with `closed` or a start is refused, which the apps' block dialog says. When an account is deleted, every block it made or received goes with it.

### Messages

| Route | Request and answer |
| --- | --- |
| `POST /conversations/{c}/messages` | `{ operationId, grant, generation, text, mentions?, root?, attachments? }` → `201 { operationId, messageId, seq }`. A retry with the same ID and content gets `200` and the first answer. `attachments` are ready uploads ([Rich messages](#rich-messages)). |
| `GET /conversations/{c}/operations/{operationId}` | → `{ messageId, seq, visible }`, or 404 when no message of the caller came from that operation. |
| `GET /conversations/{c}/events` | `?after=<seq>&limit=<n>` pages forward. `?before=<seq>&limit=<n>` gives the newest events before a sequence. → `{ events, head, floor, more }`, oldest first, 50 unless `limit` says otherwise, 100 at most. |
| `POST /conversations/{c}/messages/{e}/redact` | → `{ messageId, redacted: true }`. For the author and for a channel manager; in a DM for the author only, also once it closed. |
| `POST /conversations/{c}/read` | `{ seq, readMark? }` → `{ read, readMark }`. `readMark` is the room's `readMark` the device knew when it read; one lower than the room's now moves nothing ([Marking unread](#marking-unread)). |

A post to an archived channel or a closed DM gets `409 archived`, unless it is the retry of a message that was already in. `operationId` is a UUIDv7 in lowercase. One older than 30 days gets `409 submission_expired`. A message whose retention ran out before that keeps a receipt, so its retry still gets the first answer. `grant` is the grant the device held in the conversation when the message was written, from the feed, and `generation` the workspace's. A message written under a grant that has since ended gets `409 stale_grant`, also when the member is back in under a new one, and the device asks before sending it again. One from before a restore gets `409 stale_generation`. `text` is 1 to 16,384 bytes of UTF-8 and is stored as sent; a message with files may have none, which a reader of wire version 1 gets as the files' names ([Gate 1 routes](#gate-1-routes)). A mention is `{ actor, start, end }`: a member of the conversation, and a byte range of the text that starts and ends between characters. Mentions come in order and don't overlap, 32 at most. `root` is the ID of a top-level message in the same conversation that hasn't been removed.

Every event is `{ seq, id, kind, actor, at }` plus what its kind adds:

| `kind` | Adds |
| --- | --- |
| `message.posted` | `text`, `mentions`, `attachments`, `previews`, `reactions`, and `root` for a reply. Once removed: `redacted: true` in place of all but `root`. |
| `reaction.added`, `reaction.removed` | `target`, `targetSeq`, `emoji`. `actor` is who reacted or took it back. |
| `reaction.cleared` | `target`, `targetSeq`. A `reaction.added` or `reaction.removed` of a message that was removed afterwards, in its place. `actor` is who removed the message. |
| `message.previewed` | `target`, `targetSeq`, `previews`: the message's link cards as they are now. `actor` is the message's author. |
| `message.redacted` | `target`, `targetSeq`. |
| `channel.created` | `name`, `visibility`. |
| `channel.renamed` | `name`. |
| `channel.archived` | Nothing. |
| `member.joined`, `member.left` | `member`. `actor` is who let them in or took them out, or the member. |
| `dm.started` | `members`: the DM's people, as member IDs in the set's order. `actor` is who started it. |

A grant starts at its `member.joined` event, which is also where its read position starts. Joining a channel gives its earlier history. Posting moves the sender's read position to their message. A DM has no `member.joined` events: every grant in it starts at `dm.started`, its first event. Someone leaving a DM is a `member.left`. A DM's close shows in its feed row (`archived` and `closedReason`) and has no event of its own, so every event has an actor.

### Rich messages

A message can carry files, reactions and link cards, and a member can mark a message unread. A `message.posted` that isn't removed looks like this, with `[]` for each list it has nothing in:

```json
{
  "seq": 42, "id": "e_…", "kind": "message.posted", "actor": "u_…", "at": 1763550000000,
  "text": "The plan: https://example.com/q3", "mentions": [],
  "attachments": [
    { "id": "f_…", "name": "chart.png", "type": "image/png", "size": 48213, "width": 1200, "height": 630 },
    { "id": "f_…", "name": "report.pdf", "type": "application/pdf", "size": 210944 }
  ],
  "previews": [{
    "url": "https://example.com/q3", "title": "Q3 plan", "description": "What we do next", "site": "Example",
    "image": { "id": "f_…", "name": "preview.png", "type": "image/png", "size": 30122, "width": 1200, "height": 630 },
    "video": false
  }],
  "reactions": [{ "emoji": "👍", "actors": ["u_…", "u_…"] }]
}
```

`attachments` are in the order the post listed them; `width` and `height` only for an image whose sender gave them. `previews` are link cards: `description` and `site` may be `''`, `image` is a file or null. `reactions` holds one group per emoji, in the order of each group's first reaction, with the people in the order they reacted. A history page carries every message's reactions and cards as they are when the page is read, and the events after it change them in order.

| Route | Request and answer |
| --- | --- |
| `POST /conversations/{c}/messages/{e}/react` | `{ emoji, on }` → `{ messageId, emoji, on, changed }`. Adds the caller's reaction, or takes it back with `on: false`. |
| `POST /conversations/{c}/unread` | `{ message }` → `{ read, readMark }`. Marks a message and everything after it unread for the caller. |
| `POST /conversations/{c}/uploads` | `{ name, type?, size, sha256, width?, height? }` → `201 { upload: { id, expiresAt }, put: { url, expiresAt } }`. Reserves an upload. |
| `PUT <put url>` | The file's bytes, with `Content-Length`, and no `Authorization`. → `{ upload: { id, ready: true } }`. |
| `DELETE /conversations/{c}/uploads/{f}` | → `204`, also when there was nothing to cancel. Cancels the caller's own upload that no message has. |
| `POST /conversations/{c}/files/{f}/download` | → `{ url, expiresAt, name, type, size, sha256 }`. A link to a file of a message, valid for 60 seconds. |
| `GET <download url>` | The file, with no `Authorization`. |
| `POST /conversations/{c}/messages/{e}/previews` | `{ remove: url }` → `{ previews }`. The author takes a link card off their message. |

#### Reactions

`emoji` is one emoji, 1 to 64 bytes of UTF-8, as Unicode recommends it for general interchange (`/^\p{RGI_Emoji}$/v`): skin tones and sequences such as 👨‍👩‍👧 count as one, an emoji without its variation selector such as ❤ instead of ❤️ doesn't. Anything else is `400 invalid` with `field: emoji`; `on` must be a boolean (`field: on`). The caller needs a grant in the conversation, and the message must be a `message.posted` there that wasn't removed, or the answer is `404 not_found`. An archived channel or closed DM answers `409 archived`. A message holds at most 20 different emoji, and a 21st answers `409 reaction_limit`; another person can still add one of the twenty.

When the reaction changes, the room gets a `reaction.added` or `reaction.removed` event and its people are woken. When it doesn't, because the caller reacted with that emoji already or took back one they never gave, `changed` is false and nothing is appended. Reactions are no activity: they don't count as unread, mention nobody, alert nobody and don't move `lastAt`. Removing a message takes its reactions with it without new events. In the same transaction, every `reaction.added` and `reaction.removed` of that message becomes a `reaction.cleared`, which keeps its `seq`, `id` and `at`, names the person who removed the message as `actor` and carries only `target` and `targetSeq`: the room's history no longer says who reacted with what, and its sequence numbers stay contiguous. A client that doesn't know the kind keeps the event without its fields and shows nothing for it. Retention takes reactions with their message too.

#### Marking unread

The read position becomes `max(seq − 1, floor − 1, 0)` for the message's `seq`, when that is lower than it is: the message and what came after it count as unread again. It never moves forward here. A change adds 1 to the room's `readMark` for the caller and wakes the caller's devices, which follow the lower position from the feed ([The feed](#the-feed)). The message must be a `message.posted` of the conversation, else `404 not_found`. `read` and `readMark` in the answer are the room's for the caller afterwards.

A device that reads the room on its own may have a read on its way when the member marks something unread, and that read would move the position forward again. So a read names the `readMark` the device knew: `POST /conversations/{c}/read` with a `readMark` lower than the room's changes nothing and answers the room's `read` and `readMark`. A read without `readMark` moves the position as it always did.

#### Files

Files live in a private bucket: the R2 bucket the operator binds as `WORKSPACE_FILES`, or a bucket in an S3-compatible service that the five `WORKSPACE_FILES_S3_*` settings name ([README.md](README.md#team-chat)). The binding wins when both are there. With an S3 store the Worker signs its own requests to the service, and devices never see the bucket's address: they upload and download through the Worker with the links below, as with R2. Without a store, or with only some of the S3 settings, `GET /v1/info` lists no `files` capability and every file route answers `403 files_off`, as does a post that names files. Upload and download links have the form `<files origin>/v1/workspaces/{w}/files/<token>`, on the workspace's own address unless `WORKSPACE_FILES_ORIGIN` names another. A token is a payload and an HMAC under the server's secret, as socket tickets are, and is the only capability a PUT or GET needs. A token that doesn't check out answers `404 not_found`; one past its time `410 expired`.

1. **Reserve.** `name` is 1 to 255 characters after trimming, without control characters, line separators, `/`, `\` or the characters that turn the direction of text around. `type` is a MIME type in lowercase without parameters, at most 127 characters, and `application/octet-stream` when left out. `size` is 1 to `maxBytes` (`WORKSPACE_FILE_BYTES`); a larger one answers `413 too_large` with `limit: fileBytes`. `sha256` is 64 lowercase hex characters. `width` and `height` come together, 1 to 65,535, for an `image/` type only. A wrong field is `400 invalid` with its `field`. The caller needs a grant in a room that isn't archived (`409 archived`). A member holds at most 20 open uploads, reserved or ready but not sent, else `429 rate_limited` with `limit: uploads`. The workspace's file bytes, stored and reserved together, stay within `workspaceBytes` (`WORKSPACE_FILES_BYTES`), else `413 quota` with `limit: files`. An upload expires an hour after it was reserved unless a message took it.
2. **Upload.** The PUT's `Content-Length` must be the reserved size (`400 invalid`, `field: size`). Each attempt gets a fresh key in the bucket, which the workspace records before a byte is written. The Worker streams the body into the bucket with exactly that length and the reserved SHA-256, which is checked: R2 checks it itself, an S3 service checks it as `x-amz-content-sha256`, and with S3 the Worker also hashes the bytes as they pass and deletes an object whose bytes don't match. A digest that doesn't match is `400 invalid` with `field: sha256`, and the attempt's key goes to the trash. The upload stays open for another try. The first attempt that ends well makes the upload ready; another that ends after it gets the same answer and its key goes to the trash. A PUT to an upload that is ready, sent, cancelled, expired or gone answers `409 invalid_state`. Two PUTs to one upload may run at once (`429 rate_limited`, `limit: attempts`, for a third). PUTs draw from an allowance per upload, the one accounts outside the workspace share.
3. **Send.** `POST /conversations/{c}/messages` takes `attachments`: 0 to 10 different upload IDs, `[]` when left out. With at least one, `text` may be empty. In the post's transaction every listed upload must be the caller's, for this conversation, ready, unsent and unexpired; otherwise the answer is `409 files_unavailable` with `files` listing those that aren't, and nothing is posted. The check for a retry comes first, so a retry of a message that was posted gets its first answer. The operation's hash covers the files as well as the text, mentions and root; a message without files hashes as before.
4. **Download.** The caller needs a grant, and the file must belong to a message of this conversation that wasn't removed and that retention still keeps, or be the image of one of its link cards; otherwise `404 not_found`. The link works for 60 seconds, so a download that started can finish, and a new one needs the member's access again. It serves the stored type when it is one of `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/avif`, `application/pdf`, `text/plain`, `video/mp4`, `video/webm`, `audio/mpeg`, `audio/ogg`, `audio/webm` and `audio/wav`, else `application/octet-stream`, with `Content-Disposition: attachment` carrying the name in ASCII and in UTF-8, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: private, no-store` and `Content-Length`. A file deleted from the bucket meanwhile answers `404 not_found`. There is no `Range` support and no thumbnails: apps scale an image from its `width` and `height`.
5. **The trash.** A key whose file goes is deleted from the bucket by the workspace's alarm, usually within a minute and again after a failure: up to 1,000 keys at a time from R2, and up to 40 from an S3 store, which deletes one key per request, eight at a time, so that one alarm stays within the subrequests a Worker on the Free plan may make. That happens to the files of a removed message and its link card images, the files of messages retention removes, an upload that expired unsent or was cancelled, an attempt that lost or failed, and an attempt that never reported back within two hours. Deleting a workspace first deletes everything under its prefix in the bucket, where every key it makes lives, a page at a time, and keeps the workspace when that fails.
6. **Counting.** File bytes are counted apart from message text (`WORKSPACE_BYTES` stays text only). A reservation counts its size until a message takes it, it expires or it is cancelled; a sent file counts until its key is deleted from the bucket, so a removed file still counts until the trash is empty.

#### Link cards

When `previews` is on, a post that was just made (a `201`, never a retry's `200`) gets cards for up to three distinct addresses in its text, made after the answer, best effort and within 15 seconds in all.

- **Which addresses.** `http://` and `https://` addresses that don't start inside a word, up to the next white space, without the `.,:;!?'"` after them and without a closing `)`, `]`, `}` or `>` that has no opening one in the address, in the order they appear. Addresses longer than 4,096 UTF-16 code units, the most a card's `url` may have, addresses with a user name or password, a port other than the scheme's own, the host names `localhost`, `*.localhost`, `*.local` and `*.internal` and host names without a dot, IP addresses in loopback, private, link-local, shared (CGNAT), multicast, reserved or unspecified ranges, IPv4-mapped, NAT64 and 6to4 forms included, and the server's own hosts (`WORKSPACE_ORIGIN`, `WORKSPACE_FILES_ORIGIN`, `BOOKING_ORIGIN` and the address the post came in on) are skipped. `WORKSPACE_PREVIEW_HOSTS`, for tests only, exempts listed `host:port` pairs.
- **Fetching.** Redirects are followed by hand, at most three, each to an address that passes the same rules. Each address gets 4 seconds, with `Accept: text/html,application/xhtml+xml`, `User-Agent: Mozilla/5.0 (compatible; RukooBot/1.0; +https://rukoo.io)` and no cookies or credentials. Only a 2xx answer of type `text/html` counts, and only its first 512 KiB is read.
- **Host names.** Before each fetch, of the page, a redirect target or the image, the Worker looks the host name up through DNS over HTTPS at `https://cloudflare-dns.com/dns-query`, A and AAAA records, following CNAME answers to the addresses they lead to, within the address's 4 seconds. When any answer is in a range the rules above refuse for an IP address, or the lookup fails, runs out of time or finds no address, that address isn't fetched: a page or redirect target gives no card, and an image leaves the card without one. IP addresses and `WORKSPACE_PREVIEW_HOSTS` pairs aren't looked up. The check resolves the name before the fetch but can't pin the connection to the address it checked: the fetch resolves the name again, so a name whose answer changes in between (DNS rebinding) can in principle still reach a private address. On Cloudflare, a Worker's subrequests go out from Cloudflare's network. Any other runtime, such as the planned VPS distribution, must enforce these destination rules at its egress as well.
- **What a card holds.** `title` from `og:title`, `twitter:title` or the page's first `<title>`; `description` from `og:description`, `twitter:description` or `<meta name="description">`; `site` from `og:site_name`, else the host without `www.`; `video` when `og:type` starts with `video` or the page has an `og:video` tag. Character references are decoded, white space collapsed and control characters dropped, and the title, description and site are cut to 200, 500 and 100 characters, a cut ending in `…`. A page without a title makes no card. `url` is the address as the message has it.
- **The image**, only with a file store: from `og:image` or `twitter:image`, resolved against the page's final address and fetched by the same rules, at most 2 MiB, PNG, JPEG, GIF or WebP by its first bytes. It is stored as a file of the message named `preview.<ext>`, with `width` and `height` from the image's header when the format gives them, and counts against the workspace's file bytes. When those are used up, the card has no image.
- **Publishing.** The cards are stored on the message and announced with `message.previewed`, whose `actor` is the message's author and whose `previews` are the cards. A message gets cards once. When it was removed meanwhile, or its author removed a card before they came, nothing is appended and the images go to the trash.
- **Removing a card.** Only the message's author (`403 forbidden` for anyone else). The card goes, its image goes to the trash, and `message.previewed` carries the cards that are left; a card that isn't there changes nothing. A message whose author removed a card is never given cards again. Removing the message removes its cards.

### The feed

`GET /changes?after=<cursor>&limit=<n>&active=<c>&roomAfter=<seq>` answers:

```json
{
  "changes": [{
    "conversation": "c_…", "kind": "channel", "name": "general", "visibility": "workspace", "archived": false,
    "grant": "g_…", "role": "member", "members": 14,
    "head": 42, "floor": 1, "lastAt": 1763550000000, "read": 40, "readMark": 0, "unread": 2, "mentions": 1,
    "removed": ["e_…"], "removedMore": false
  }, {
    "conversation": "c_…", "kind": "dm", "name": null, "visibility": "dm", "archived": false,
    "participants": ["u_…", "u_…", "u_…"], "startedBy": "u_…", "closedReason": null,
    "grant": "g_…", "role": "member", "members": 3,
    "head": 12, "floor": 1, "lastAt": 1763550000000, "read": 10, "readMark": 0, "unread": 2, "mentions": 0,
    "removed": [], "removedMore": false
  }],
  "evictions": ["c_…"],
  "inlineEvents": [],
  "directory": { "members": false, "channels": true, "blocks": false },
  "next": "…",
  "more": false
}
```

`members` is how many people hold a grant in the room now. `lastAt` is the time of the room's newest event that isn't a reaction or a link card (`reaction.added`, `reaction.removed`, `reaction.cleared`, `message.previewed`), or null once retention removed it; clients order DMs by it. `readMark` counts how often the member marked a message unread there: a device that sees it higher than it knew takes `read` from the row, also when that is lower than its own. A DM has `name: null` and three fields of its own: `participants`, its fixed set of people as member IDs in the order of `dm.started`, the caller included; `startedBy`; and `closedReason`, null while it is open and else `left`, `ineligible` or `closed`. `archived` is true exactly when `closedReason` isn't null, so a device can post in any room that isn't `archived`. Names, roles and states come from `GET /members`: everyone in a DM is a full member, and full members get every active member and the 1,000 most recent former ones.

Without `after` the answer starts a pass over every room the caller is in. `limit` is 32 unless given, 100 at most. `unread` and `mentions` count up to 100, which a device shows as 99+. `removed` lists the messages redacted in that room since the cursor, 64 at most, and `removedMore` says there were more. `evictions` are rooms the caller lost. `inlineEvents` are up to 20 events of the `active` room after `roomAfter`. `directory` says whether to load `GET /members`, `GET /channels` and `GET /blocks` again. For a guest `channels` is always false, and `members` is true only when someone they share a room with changed, came or went. `blocks` is true on a pass from the start and when the caller's own blocks changed since the cursor, and never because someone blocked them. A cursor is sealed: it opens only for its member, in its restore generation, and its length says nothing.

A pass can take several pages, and a room can change again while a device is paging. The cursor therefore remembers where its pass began as well as where its scan is, and `removed` lists what was redacted since the pass began. A device may see the same ID on two pages of one pass.

`410 reset_required` means start a pass without a cursor: the cursor isn't this member's, is from another generation, or is older than the 14 days the feed remembers redactions and evictions. `409 history_regressed` means the cursor is ahead of the workspace, which happens when its database was rolled back.

### Wake socket

`POST /socket-ticket` → `{ ticket, expiresAt, protocol }`. The ticket works once, for 30 seconds, for the session that asked, and only while that session is still signed in. `GET /socket` upgrades with `Authorization: Ticket <ticket>`. A client that can't set that header offers the subprotocols `rukoo.workspace.v1` and `rukoo.ticket.<ticket>`, and the server answers with the first. A ticket in the address is never read.

The server sends one frame, `{"t":"wake"}`, when something changed for this member, at most twice a second. The device then fetches `/changes`. The server answers a `ping` frame with `pong`. A socket stays authorized for 15 minutes after its session's last request to the workspace: a request renews it, a ping doesn't, and a socket whose time ran out is closed with code 4001 at the next wake. Code 4003 means the member was removed, or the workspace was deleted.

### Limits on requests

The workspace counts requests in memory, per account: about 8 reads a second with bursts of 60, 3 writes a second with bursts of 30, a socket ticket every five seconds with bursts of 6, and a new DM every ten seconds with bursts of 10. Listing blocks and asking for a download link are reads; unblocking, reacting, marking unread, reserving or cancelling an upload and removing a link card are writes. A PUT to an upload link has no session, so each upload gets the allowance of an account that isn't a member. Removing a member or a message, leaving a channel, a DM or the workspace, archiving, changing a role, withdrawing an invitation, blocking someone and deleting the workspace draw from their own allowance and skip the workspace-wide ceiling, so they go through while a workspace is busy. Accounts that aren't members share one small allowance. The numbers are first guesses until Gate 3 measures a deployed workspace.

### Not built yet

DMs with guests, editing and forwarding messages, thumbnails made by the server, ranged downloads, agents and their runner, MCP, guest sign-up vouchers and workspace-only accounts, the encrypted kit, signed checkpoints, bans and reports, closing a workspace that still has other members, renaming a workspace, opening invitation links in the apps, appointing a manager for a channel whose only manager was removed, two people co-signing a guest's admission, per-member storage accounting, the operator CLI and protected recovery. Nothing has been measured on a deployed Worker.

## Fixture index

| ID | Failure or behavior to verify |
| --- | --- |
| WK-1 | Legacy desktop/Android cache and export contain only the inner-encrypted kit. Updated clients can import; wrong key or kit ID fails. Disconnecting a borrowed session preserves personal sync. |
| WK-2 | Two invite issuers, deleted issuer during delayed cleanup, voucher cancellation racing signup, no personal record or Book access for voucher accounts. Delete/recreate the same locator over residual cleanup state and check Book's exists() semantics. |
| WK-3 | Re-grant boundaries, sponsor deletion, blocked/deleted DM peer, orphaned channel management, guest channel discovery denial, self-join marker and blocked-actor mention in a shared channel. Every public endpoint, file open, MCP tool and export uses the same grants. |
| WK-4 | Ordered sends, duplicate retry, changed-payload conflict, ancient ID, lost ACK followed by lookup of a retained post after 30 days, dropped wake, redaction and read receipt without another posted message, Unicode mention offsets, invalid roots, departed or DM agent mentions, monotonic reads, and oversized agent output. |
| WK-5 | Two triggers in a page, lease takeover immediately before old terminal commit, lost reply acknowledgement and runner journal loss. At most one reply per terminal trigger. Also test budget exhaustion, expired mentions during downtime, and a model choosing no reply. |
| WK-6 | Concurrent upload attempts, size/hash mismatch, expiry and late finalize, prebind/after-redaction denial, repeated expiry while deletion is paused, physical-budget exhaustion, resumed cleanup and storage unavailable. Let a write settle after the first cleanup pass, then check both the bucket's contents and the counter. |
| WK-7 | Cross-host and cross-generation cache isolation, cursor reset during directory changes, socket ticket replay, a same-generation cursor ahead of server or pointing to a different retained ID, and older/newer client negotiation. During a mixed-version rollout attempt a full member's account deletion and confirm workspace activation is gated until old traffic drains. Exercise an older client receiving `403 workspace_account_scope` without losing its session. Redact an old cached post while the phone is offline with an unchanged grant, expire its cursor, then reset; timeline, preview and search must all lose the body. Repeat with the desktop connected in A throughout and the cached post redacted in unopened room B. Search and preview in B must hide it as soon as the feed cursor advances, even across a restart. A retention sweep that expires one message, and a redaction of one message, leave the rest of that room's cache and search intact. With more rooms than fit on a page, redact in the last room, post in the first and restart the client between pages: the redacted text is gone once the pass completes. |
| WK-8 | Protected backup watermark, writer cutover and verified restrictions; the basic CLI's refusal of historical rollback and identity-loss behavior. [Recovery drills](WORKSPACE-RECOVERY.md) |
