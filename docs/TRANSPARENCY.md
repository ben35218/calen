# What Calen Can and Can't See

*The user-facing transparency note (Signal-parity plan E1). The in-app Privacy &
data section shows the summary; this file is the authoritative long form and the
source for the website page. Update it whenever a Signal-parity item changes
what the server stores.*

Last updated: 2026-07-20.

## The short version

Your household's content — events, people, tasks, chores, recipes, trips,
items, notes, photos of manuals, your home address — is **end-to-end
encrypted**. It is encrypted on your device with keys we never have, before it
is uploaded. We cannot read it, our staff cannot read it, and there is no
admin override or recovery backdoor: if you lose all of your unlock methods
(passkey, recovery code, password), **we cannot recover your data**, by design.

## What our servers CAN see

- **Account identity:** your email address, first/last name, and account
  timestamps. Email is how invitations work.
- **Household structure:** who is in which household, when members join or
  leave, and the household's name.
- **Encrypted records:** that a record exists, which household owns it, when it
  was created/changed, its key version, and its (padded) size. Not its content.
- **Scheduling metadata:** task/chore due dates (`nextDueDate`) — timing, not
  titles; titles are encrypted.
- **Billing:** your plan and how many AI actions you've used (counts only).
- **Devices:** a name/platform label for each signed-in device (shown to you in
  Sign-in & Security).
- **Operational logs:** request timing and IPs, like any server. Logs reference
  records and users by id only — never content, titles, or email subjects with
  codes in them. Log retention follows our host's (Render) default rolling
  window; we persist no request bodies.

## What our servers can NEVER see

Record content: titles, descriptions, dates inside events, locations, notes,
people's details and birthdays, your home address, attachments and manuals
(encrypted per-file), AI conversations (see below), passwords, or any
encryption key.

## Deliberate exceptions — content that is NOT end-to-end encrypted

We believe stating boundaries exactly matters more than pretending there are
none. The following are plaintext on our servers **because a feature you chose
requires it**:

1. **Things you share outside your household.** A trip shared with someone
   outside your family, or a calendar shared by email, is stored readably so
   your collaborator can read it (they don't hold your household key).
   Un-sharing re-encrypts on the next edit.
2. **Event invitations to people without accounts.** The invitation carries a
   readable snapshot of that one event (that's what makes the email + calendar
   attachment work). Revoking the invitation deletes the snapshot.
3. **AI phone calls** *(not available in the current release — the feature is
   switched off on our servers, so none of the below happens today; this entry
   stays so the rules are on record for if it is ever turned on).* When Calen
   calls a business for you, the event's title,
   date, and the business number necessarily leave encryption to make the
   call, and the call's outcome summary is stored so your household can see it.
   Calls are **not recorded and no transcript is kept** — not by us and not by
   the voice provider; the outcome summary is the only record of the call, and
   it is generated under instructions to state the outcome only — no names,
   contact details, or account numbers spoken on the call. Your phone number /
   email are given to the caller only when you switch on "Share my contact
   details if asked" for that call.

## AI features (Anthropic)

- AI requests are **per-request and consent-gated**: your device decrypts only
  the records the assistant needs and sends them for that request. We do not
  store prompt content.
- Since 2026-07-17, AI payloads are **minimized**: database identifiers are
  stripped and replaced with per-conversation aliases before anything leaves
  your device — Anthropic sees the content you consented to share and opaque
  labels, nothing linkable to stored records. We send Anthropic no account
  identifiers; requests come from our servers, not your IP.
- Since 2026-07-20, AI payloads are also **need-to-know**: your family and
  friends appear to the AI by **name only** (no birthdays, addresses,
  interests, or notes — the assistant fetches names on demand rather than
  receiving your roster), phone numbers and booking confirmation codes are
  replaced with "on file" markers, call transcripts don't exist at all (the
  outcome summary is the only record of a call), and web lookups of
  professional contacts run only when you turn them on for an import.
- Anthropic does not train on this API traffic by default.
  <!-- G3 (OPS ACTION, Ben): request a Zero-Data-Retention agreement for the
  org via Anthropic sales/support, then update this bullet with the outcome
  (granted → "prompts are not retained at all"; declined → state their
  standard retention window). -->
- Every AI surface shows a "sent to Anthropic" indicator, and the AI toggles in
  Privacy & data turn it off entirely.

## Security features you should know exist

- **Safety numbers:** verify a family member's encryption key from the
  Household screen; you're alerted if it ever changes.
- **Security alerts:** every member is notified when an unlock method is added
  or removed, a member joins or is removed, the household key rotates, or a
  new device signs in.
- **Key rotation & retirement:** the household key rotates when someone is
  removed (and periodically); old records are re-encrypted under the new key
  and the old keys are destroyed, so a removed member's key opens nothing.
- **New-device protection:** a password reset from an unrecognized device is
  delayed and loudly announced to your devices and email, and you can cancel
  it with one tap.
- **Screen security & app lock:** screenshots/recording can be blocked and the
  app can require Face ID again after being in the background.

## Government & legal requests (E4)

What a valid legal request can yield is exactly the "What our servers CAN see"
list above — and nothing more:

- Account email/name, household membership and its timestamps, household name.
- Ciphertext (unreadable without keys we do not possess), record
  existence/timing metadata, task due dates.
- Plan/billing status and AI usage counts.
- The deliberate-exception content listed above, if any exists for the account.

We **cannot** produce record content, message-equivalent data, location
content, keys, or AI conversation content, because we do not have them. There
is no lawful-intercept capability and no mechanism to add one for a specific
user without shipping different client software to everyone.

Commitments:
- We will publish counts of legal requests received/complied with
  (transparency report) once any are received.
- Where legally permitted, we will notify the affected user before disclosure.

## Build verifiability (E5)

End-to-end encryption only protects you if the app you run is the app we
published — encryption in honest source code means nothing if a tampered binary
quietly keeps a copy of your key. So: can you verify the app on your phone
matches our source?

**What is out of reach.** Fully reproducible, byte-for-byte builds are not
achievable on Apple's platform today. Our iOS builds run on Expo's EAS cloud,
Apple re-signs the binary when it's submitted, and the App Store re-encrypts the
download per device (FairPlay) — so nobody, including us, can hand you an IPA to
byte-compare against one you build yourself. This is an industry-wide iOS
limitation, not specific to Calen.

**What we CAN attest — the source → build chain.**

- **Pinned dependencies.** Every package is locked to an exact version *and* a
  cryptographic integrity hash in committed lockfiles (`package-lock.json` for
  the app, server, and the crypto module). A given source commit therefore
  resolves to one deterministic dependency tree. The whole crypto surface is
  pinned this way — `react-native-libsodium` and the in-repo `@household/crypto`
  module (the audited E3 target), which is small and readable on purpose.
- **Builds tied to a commit.** Each EAS build records the exact git commit, the
  build profile, the SDK/runtime version, and a full, retained build log. A
  released store version can be traced back to the specific public commit it was
  built from.
- **Published spec + open source.** The client cryptography is documented in
  `CRYPTO-SPEC.md` and lives in source you can read; the automated test bar
  (`shared/crypto`, calendar, server, and app suites) gates every change.

**The remaining gap (honest).** We do not yet run a *public* CI that builds each
release from a tagged commit and publishes the resulting EAS build id + logs — so
today the commit↔build link is auditable by us, not yet independently by you. A
public build recipe (a `.github/workflows` pipeline that builds from a tag and
records the EAS build receipt) is the concrete next step, and Android — where
reproducible builds and APK-signature comparison are more tractable — is a
stronger future target than iOS.

**Bottom line.** We can attest the input side (public commit → pinned deps → a
logged EAS build) but not a user-reproducible binary on iOS. The practical
protection against a targeted, backdoored client is the same one the legal
section relies on: the source is public and builds are logged against commits, so
shipping different software to one user — rather than to everyone — is not
something that can be done quietly.

## Transport security & certificate pinning (F6)

All traffic between the app and our servers is HTTPS/TLS. A separate question is
certificate *pinning* — hard-coding which server certificate the app will trust,
so a mis-issued or attacker-obtained certificate is rejected even if a certificate
authority (CA) vouches for it. We investigated whether we can pin, and concluded:

- **Leaf / public-key (SPKI) pinning is not workable on our current setup.** Our
  API terminates TLS on Render-managed certificates that rotate automatically on a
  schedule we don't control, with a fresh key each rotation. A pinned app shipped
  before a rotation would stop connecting after it — and an app-store update can't
  always reach every device in time. Pinning the exact cert/key here would trade a
  rare attack for routine self-inflicted outages.
- **CA pinning is fragile and weak.** Pinning the issuing CA survives leaf
  rotations, but managed platforms switch issuers (Render has moved between Let's
  Encrypt and Google Trust Services), which would silently brick pinned clients;
  and it only narrows trust to "any certificate that CA issues," not ours.
- **What we can do without brick risk (and plan to):** a **DNS CAA** record that
  restricts which CAs may issue certificates for our domain (limits mis-issuance,
  invisible to clients); **HSTS** on the web/API surface; and **Certificate
  Transparency monitoring** — every certificate for our domain is logged publicly,
  so we can watch for one we didn't request (detection rather than prevention, zero
  client risk). `Expect-CT` is obsolete (browsers enforce CT by default) so we
  don't use it.
- **Why the stakes are lower here than for a bank.** Pinning defends the transport
  channel — but our threat model already treats the server and network as
  untrusted. Content is end-to-end encrypted under keys that never travel the
  network in the clear, so even a fully broken TLS session exposes only ciphertext
  and routing metadata, never readable content. Transport hardening is
  defense-in-depth, not our primary confidentiality control.

**If pinning becomes a hard requirement**, the prerequisite is moving off
managed certificates to a bring-your-own-certificate setup with a long-lived,
app-controlled key and a published backup pin — then public-key pinning with an
overlap window is safe. Until then, CAA + CT monitoring is the honest, operable
posture.

## Data retention

- Encrypted records: kept until you delete them or your account.
- Account deletion (Profile → Delete account): permanently removes the account
  and all data, immediately.
- Email log: template + delivery status per email; codes/secrets are masked
  out of stored subjects.
- Audit log: security lifecycle events (who/when, never content).
