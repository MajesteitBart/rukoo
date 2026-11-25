// The privacy statement at /privacy, in English or Dutch. It is filled in from the operator's settings, so a fork
// that deploys this server gets one that names it; read it through and change what doesn't fit your setup before
// people sign up. Set PRIVACY_URL to use a statement of your own elsewhere instead.

import { escape, link } from './page.js';

// When the text below last changed in a way that matters to the people it describes.
export const UPDATED = '2026-11-25';
const PROTOCOL_URL = 'https://github.com/MajesteitBart/rukoo/blob/main/server/PROTOCOL.md';

const TEXT = {
  en: {
    title: 'Privacy statement for Rukoo accounts',
    updated: (date) => `Last updated ${date}.`,
    other: '<a href="/privacy?lang=nl">Nederlands</a>',
    who: 'Who is responsible',
    whoText: (op) => `${op} runs this server and decides what it does with your data.`,
    unnamed: 'Whoever runs this server hasn’t filled in their name. They decide what it does with your data.',
    contact: (c) => ` Contact: ${c}.`,
    what: 'What this service is',
    whatText:
      'A Rukoo account keeps your inbox categories, the category each email got and your corrections the same on your devices that use Rukoo, the open-source mail app. If you turn it on, it also runs your booking page, where other people and their AI assistants can book time with you. Your mail, your mail passwords and your Google sign-ins never pass through this server.',
    whatChat:
      'This server also runs team chat: workspaces where you talk with others in channels and direct messages. Unlike your records, team chat is readable on this server (see Team chat).',
    data: 'What we keep',
    dataItems: [
      'Your email address, which is your sign-in name. We don’t send mail to it and don’t check it.',
      'A check value derived from your password on your device. It lets the server confirm your password; it isn’t your password, and the server can’t turn it back into one.',
      'Your encrypted records. Your devices encrypt them with a key that only they have, so we can’t read them: not your categories, not your corrections, not which email went where.',
      'Your encrypted data key, wrapped by your password and by your recovery key. We can’t open it.',
      'The names and platforms of your devices, when each one signed in and when it last connected.',
      'How many records you have, how large they are and when they change.',
      'Failed sign-in attempts, to lock sign-ins with an address for 15 minutes after ten of them. They are counted under a hash of the address, also for an address without an account, and deleted when the lock ends or 15 minutes after the first attempt. Wrong passwords entered on a signed-in device count for that device alone.',
      'If you turn on a booking page: what it publishes and the bookings made on it, as Booking pages below describes.'
    ],
    dataChat: 'If you use team chat: the workspaces you are in and what you write and do there, as Team chat below describes.',
    // While the server sends codes by email: the first item and an addition to the lock item. signup: whether a
    // sign-up needs a code.
    emailItem: (signup) =>
      signup
        ? 'Your email address, which is your sign-in name. Unless you sign up with an invite code from us, we check it with a code we send there before we make your account. We send it no other mail than the codes you ask for (see Email codes).'
        : 'Your email address, which is your sign-in name. We don’t check it, and send it no other mail than the codes you ask for (see Email codes).',
    lockCodes: ' A code sent to your email address lets you sign in or recover your account during the lock.',
    codes: 'Email codes',
    codesText: (signup) => [
      `${signup ? 'You can ask this server for a six-digit code by email: to make an account, and to sign in or recover your account while failed attempts have locked it.' : 'You can ask this server for a six-digit code by email, to sign in or recover your account while failed attempts have locked it.'} The six-digit code works once, for 10 minutes, on the device that asked for it. Each email also has a longer code that works once, on any device, for a day, so you can use any email you get, also one someone else asked for.`,
      'Resend, a service of Resend, Inc. in the United States, sends these emails on our behalf under its data processing terms. It gets your email address and the email, with the codes in it, stores them in the United States and keeps them for 30 days on its standard plans.',
      `Asking gets the same answer whether or not the address has an account, so nobody learns that from it.${signup ? ' If you ask for a sign-up code for an address that already has an account, the email says so instead of carrying a code.' : ''} An address without an account gets no sign-in code.`,
      `For each code someone asks for, this server keeps hashes of the address, of both codes and of a random value the asking device got back, how many wrong tries were made, whether the email went out, and when the codes expire. It doesn’t keep the address itself. They are deleted when a code is used, after five wrong passwords or recovery keys with it, or a day after it was asked for, or after 10 minutes when no email with the codes went out. To limit how many codes one address gets (one a minute, five an hour and ten a day, for making an account and for signing in each), it also keeps when codes were asked for an address, under a hash of the address, until a day after the last time. It keeps both also when no email goes out because the address has no account. To limit how many sign-in emails one mailbox and one address get, it keeps when they went out, under a hash of the mailbox or the address, for a day.${signup ? ' To limit how many accounts the addresses at one domain make in a day, it counts the accounts made there with a code, under a hash of the domain, until the day is over. When a domain reaches that limit, the server names the domain, without any address, in its log, and in an email to whoever runs it when they asked for one, so a mail provider that shouldn’t be limited can be let through.' : ''} It doesn’t keep your IP address for this.`,
      signup
        ? 'We send codes to make the account you ask for and to let you in while a lock keeps others out (the agreement with you, article 6(1)(b) GDPR). Checking addresses and limiting codes protect people from accounts made with their address, and the service from abuse (a legitimate interest, article 6(1)(f) GDPR).'
        : 'We send codes to let you in while a lock keeps others out (the agreement with you, article 6(1)(b) GDPR). Limiting them protects people and the service from abuse (a legitimate interest, article 6(1)(f) GDPR).'
    ],
    whereCodes: 'Resend, a service of Resend, Inc. in the United States, sends the emails with codes and keeps them there (see Email codes).',
    ip: 'Your IP address reaches Cloudflare with every request. The server uses it to limit how often one address may try to sign in or write to a booking page, and doesn’t store it. For bookings it also counts how many came from one network that day (an IPv4 /24 or an IPv6 /64). It keeps those counts only as hashes made with a key that changes every day, and deletes them once the host’s day is over. Cloudflare may keep addresses in its own logs for a short time.',
    why: 'Why',
    whyText:
      'We use this data to give you the account you asked for: signing in, syncing your devices and showing your devices and usage (the agreement with you, article 6(1)(b) GDPR). Rate limits and the sign-in lock protect your account and the service (a legitimate interest, article 6(1)(f) GDPR). We don’t use it for anything else: no analytics, no advertising, no profiles, and we don’t sell or share it.',
    where: 'Where it is kept, and who helps',
    whereText: (place) =>
      `The server runs on Cloudflare, a service of Cloudflare, Inc. in the United States, which processes the data on our behalf under its data processing terms. ${place} Because Cloudflare is a US company, US law applies to it, also for data kept in the EU. What it could be made to hand over is the list above: your records stay encrypted with a key Cloudflare doesn’t have. A booking page is different: what it publishes is readable, and so are a guest’s details at the moment they book (see Booking pages).`,
    // files: null without a files bucket, else as chatText gets it. With an S3-compatible store, a second sentence says
    // where its files are kept. agents: whether members can add agents, which pass what they read outside this server.
    whereChat: (files, agents) =>
      `Team chat is readable too: its workspaces, ${files ? 'who is in them, their messages and files' : 'who is in them and their messages'} (see Team chat).${files?.s3 ? ` Its files are kept at ${files.s3.at}.` : ''}${agents ? ' An agent in a channel passes what it reads there on to a program its sponsor chose, which isn’t part of this server (see Team chat).' : ''}`,
    places: {
      eu: 'Accounts are stored and handled in the European Union.',
      us: 'Accounts are stored and handled in the United States.',
      fedramp: 'Accounts are stored and handled in FedRAMP-Moderate data centers in the United States.',
      any: 'Each account is stored in one Cloudflare location, usually near the device that made it.'
    },
    keep: 'How long',
    // days: EXPIRE_UNUSED_DAYS, after which an account that is never used is deleted, or 0 when none are.
    keepText: (days) =>
      `We keep your account until you delete it. Delete account in Rukoo (Settings, Rukoo account) removes the account, every record and your booking page with its bookings at once. Cloudflare keeps backups of the storage that can bring back its state from up to 30 days before, so deleted data is fully gone after that. ${
        days
          ? `An account that is never used is deleted ${days} days after it was made, so it doesn’t take a place someone else needs: one that never stored a record, was never in a workspace, never had a booking page, and that no device signed in to or connected with after the day it was made. Other inactive accounts aren’t deleted on their own; ask us if you want yours removed and can no longer sign in.`
          : 'Inactive accounts aren’t deleted on their own; ask us if you want yours removed and can no longer sign in.'
      }`,
    rights: 'Your rights',
    rightsText:
      'You can see what is stored about you on the What’s stored and shared page in Rukoo, export everything with Export my data, change your password and delete your account yourself. For anything else, such as a copy of the data we hold or an objection, contact us. You can also complain to a data protection authority, such as the one in the country where you live. If you booked time with someone through a booking page, Booking pages below says what you can do.',
    rightsChat: 'That page and Export my data don’t cover team chat; Team chat below says what you can do there.',
    booking: 'Booking pages',
    bookingText: [
      'A booking page, at an address that ends in a name the account holder picks, lets other people and their AI assistants book time with that account holder: the host. It is off until the host turns it on in Rukoo. While it is on, this server keeps what the host publishes, readable, because it has to offer times while the host’s computers are off: the host’s name, introduction, time zone and language, the meeting types with their public locations, an optional contact line, the hours the host is open and the busy times within them (to the quarter hour, without titles or other details), and when the page was last updated. The page shows the open times, never the busy times themselves.',
      'If you book through a booking page, you are a guest. You give your name, your email address, an optional note and, when an assistant books for you, the assistant’s name. They go to the host: the host’s Rukoo puts the meeting in the host’s calendar, and the host’s calendar and mail provider, such as Google, sends you the invitation. From then on the host decides what happens with your details. The host’s Rukoo keeps its own copy, end-to-end encrypted, and deletes it 30 days after the meeting; the meeting itself stays in the host’s calendar like any other.',
      'We handle a guest’s details to make the booking the guest asks for, on the host’s behalf (steps taken at the guest’s request, article 6(1)(b) GDPR). Limits on how often and from where bookings come protect hosts and the service (a legitimate interest, article 6(1)(f) GDPR).',
      'This server reads a guest’s details once, when the booking is made, to seal them: it encrypts them with a key that only the host’s devices hold, and keeps only that sealed copy. A later leak of the storage, a backup or a break-in afterwards doesn’t reveal them. But the details do pass through the server readable at the moment of booking, so the operator, or someone who has broken into the server at that moment, could read them then. Next to the sealed copy the server keeps the booking’s time, meeting type and status, how it was made (the web page, the JSON API or MCP), a hash of the key in the guest’s manage link, and, while the booking is active, a hash of the guest’s email address bound to that time, so the same booking isn’t made twice.',
      'A booking stays on this server until 30 days after the meeting. When the guest cancels, the host declines or a request lapses, the sealed details and the email hash are deleted at once; the rest goes 30 days later. When the host turns the page off or deletes their account, the page and all its bookings are deleted.',
      'A guest can cancel the booking with the link on the page they saw after booking; that deletes their details from this server straight away. For what the host does with them, contact the host. For anything about the copy on this server, contact us.',
      'Hosts write their own pages; we don’t check them. To report a page that pretends to be someone else or is abusive, use Report this page at the bottom of it, or contact us.'
    ],
    chat: 'Team chat',
    // days: how long the server keeps messages (WORKSPACE_RETENTION_DAYS). signups: whether an invitation works as an
    // invite code here, 'checked' when such a sign-up also needs an emailed code. previews: whether the server makes
    // link previews (WORKSPACE_PREVIEWS). files: null without a files bucket, else { max, total, s3 }: the largest
    // file and a workspace's file space, written out (bytesText), and s3 null for the WORKSPACE_FILES bucket, else
    // what s3Keeper says for an S3-compatible store. agents: whether members can add agents (WORKSPACE_AGENTS).
    chatText: (days, signups, previews, files, agents, push) => [
      'Team chat lets people with an account on this server make workspaces and talk there in channels and in direct messages. For each workspace you are in, this server keeps the name you use there, your role, when you joined and left, the channels and direct messages you are in, how far you have read in each, how often you marked a message unread there, and the messages you write, with the people you mention and, for a reply in a thread, the message it answers. When you react to a message, it keeps which emoji you used and when. It also keeps the people you block, the invitations you make, an ID your device gives each message so a retry isn’t posted twice, and when you started direct messages, to limit how many you start; those times become due for deletion after a day.',
      'Team chat isn’t encrypted end to end, unlike your records. Messages are stored as they were written, so we can read and change them, in channels and direct messages alike, and so can Cloudflare. We also see who is in which conversation. We handle team chat to give you the workspaces you make or join (the agreement with you, article 6(1)(b) GDPR).',
      ...(previews
        ? [
            `When a message holds web addresses, this server fetches up to three of those pages and adds a link preview of each to the message, with the page’s title, a short description and the site’s name${files ? ', and the page’s image, which it keeps as a file of the message' : ''}. The site sees a request from this server, not your IP address. A preview is kept with its message, and its details also go into the conversation’s history in a separate event: the address, title, description and site name, whether the page is a video${files ? ', and its image’s file ID, name, type, size and dimensions' : ''}. Removing the message removes its previews from both. When the message’s author removes a preview, it is hidden${files ? ' and its image deleted' : ''}, but its details can stay in the history. Preview details in the history can also outlast their message, until those events are deleted with the rest.`
          ]
        : []),
      ...(files
        ? [
            files.s3
              ? `Files you send in team chat are kept in private storage at ${files.s3.at}, with their name, type and size. This server also keeps their name, type, size and a hash of their content, and for an image its width and height. ${files.s3.keeps} Like messages, they aren’t encrypted end to end, so we can open them, and so can ${files.s3.who}. A file can be up to ${files.max}, and all files in a workspace up to ${files.total} together. Your devices upload and download them through this server, which runs on Cloudflare, so they pass through Cloudflare readable on their way. Only people who can read the message get a download link, and it works for 60 seconds. A file is deleted from storage, usually within a minute, when someone removes its message or the message itself is deleted. A file that isn’t sent becomes due for deletion an hour after its upload began. Deleting a workspace deletes its files too.`
              : `Files you send in team chat are kept in private storage at Cloudflare R2, with their name, type, size and a hash of their content, and for an image its width and height. Like messages, they aren’t encrypted end to end, so we can open them, and so can Cloudflare. A file can be up to ${files.max}, and all files in a workspace up to ${files.total} together. Your devices upload and download them through this server. Only people who can read the message get a download link, and it works for 60 seconds. A file is deleted from storage, usually within a minute, when someone removes its message or the message itself is deleted. A file that isn’t sent becomes due for deletion an hour after its upload began. Deleting a workspace deletes its files too.`
          ]
        : []),
      'Inside a workspace, owners, admins and members see the name and role of everyone in it and of people who left. Guests see the people in the channels they are in. Members can find and join any channel open to the whole workspace, and whoever joins a channel can read its earlier messages too. Guests see only the channels they were added to. Only the people in a private channel see its name and messages, and only the people in a direct message see that conversation. Owners and admins see the invitations that are still open. Someone you block isn’t told, but may notice that a direct message with you closed or that they can’t start one.',
      ...(agents
        ? [
            'Owners, admins and members can make agents: accounts in the workspace that a program answers for, such as an AI assistant. Whoever makes one is its sponsor and picks that program, which runs outside this server: on the sponsor’s own computer, for example, or at a service the sponsor chose. An agent is listed in the workspace like a person, marked as an agent. A channel’s managers can add it to their channel, and its sponsor can add it to a channel open to the whole workspace that the sponsor is in. It can be in a private channel only while its sponsor is in it, and it leaves that channel when its sponsor does. In each channel it is in, it can read what a person there can: the messages, earlier ones included, their files and who is in the channel. It passes what it reads on to that program, which may send it on to the provider of an AI model. This server can’t see or control that program, and what happens there with what the agent reads is up to the sponsor and whoever runs the program, not us. An agent posts only to answer a message that mentions it, and for each reply this server checks that the agent may answer whoever wrote that message or, when another agent wrote it, the person who started that exchange.',
            'For each agent, this server keeps its name, its sponsor, whom it answers, whether it answers other agents, when it was made, when it last used the server, a hash of its key and, with each reply, the message it answers. Owners, admins and members see when each agent last used the server. An agent’s key is a secret like a password: whoever has it can read the agent’s channels and post there as the agent. Only its sponsor can make a new key, which stops the old one at once. Its sponsor, an owner or an admin can remove the agent, and its sponsor can remove what it wrote. An agent is also removed when its sponsor leaves the workspace, is removed from it, becomes a guest or deletes their account. Removing an agent deletes the hash of its key. Its name and settings stay in the workspace, like a former member’s, and what it wrote stays until it is deleted with the rest.'
          ]
        : []),
      ...(push
        ? [
            'Rukoo for Android can ask this server to wake it when something comes that would notify you, a direct message, a mention or a reply to your message, so the notification comes while the app is closed. The phone then gives this server the address of the push service it uses, such as ntfy, and the keys to encrypt for it. This server keeps them with that session and deletes them when the session ends, for example when you sign out, or when that phone turns team chat notifications off. A wake is encrypted for your phone and says only that there is something new: no workspace, conversation, name or text. The phone then fetches what is new from this server itself. The push service sees that a wake went to your phone and when, and is run under its own terms by whoever runs it, not by us. On a phone without such an app, Rukoo for Android uses Google’s Firebase Cloud Messaging, through Google Play services, as its push service. Google LLC then gets from this server, with each wake, the token Google gave that phone, sees when a wake is sent, and keeps the encrypted wake until the phone takes it, for a day at most. Google can’t read the wake, which says nothing about your messages anyway. Google runs that service under its own terms, also outside the EU. We send wakes to give you the notifications you turned on (the agreement with you, article 6(1)(b) GDPR).'
          ]
        : []),
      `An invitation is a link with a secret in it. Whoever has the link can use it once, for as long as it works: a day, unless its maker picks up to seven. Send it only to the person it is for. In the workspace, this server keeps a hash of the secret, who made the invitation, the role and channels it gives, when it expires and who used it. That record becomes due for deletion 30 days after the invitation expires. An invitation stops working when it is withdrawn, or when its maker leaves or can no longer invite.${signups ? ` On this server an invitation also works as an invite code: someone without an account can make one with it, one account per invitation.${signups === 'checked' ? ' They still confirm their email address first, with a code we send there.' : ''} For that, the server keeps a separate record of each invitation someone signed up with, or tried to: a hash of its secret and how many accounts it made. That record has no end date and stays even if the sign-up failed or the account is deleted later, so an invitation can’t make a second account.` : ''}`,
      `Messages become due for deletion ${days === 1 ? 'a day' : `${days} days`} after they were written, together with the other events in each conversation, such as who joined or reacted. A cleanup runs at least once a day and deletes what has become due; a cleanup that fails is tried again later. A message someone removes loses its text and its reactions at once, and removing it also clears who reacted to it with which emoji. An archived channel or a closed direct message goes once nothing is left in it. The server remembers which messages were removed and who lost access to which conversation, so devices that were away can catch up; that record becomes due for deletion after 14 days. An owner who is the only member of a workspace can delete it, which deletes everything in it at once. The 30 days of backups under How long apply here too: for that time, removed messages can be brought back.`,
      'When you leave a workspace or are removed from it, you lose access to its channels and direct messages, your direct messages there close and your open invitations stop working. What you wrote stays, under your name, until it is deleted with the rest. Your account keeps a list of the workspaces you are in or were in, so each of them hears when you delete your account. Deleting it makes you leave every workspace you are still in, takes your name off what you wrote, so it shows as written by a deleted member, and deletes every block you made or received. The messages themselves stay until their workspace deletes them. A workspace where you are the only member stays on the server with nobody in it. Its messages go when they are deleted with the rest, but its name stays, so delete it in Rukoo first if you want it gone at once. Until each workspace has heard of the deletion, the server keeps only that workspace’s ID and a random ID of your account, without your email address, credentials or records. Each workspace then keeps that random ID until it becomes due for deletion after 30 days, so nothing still on its way in under it gets through.',
      'In Rukoo you change your name in a workspace, remove your own messages and leave a workspace yourself. Export my data doesn’t include team chat. Each of your devices keeps its own copy of team chat and deletes it when its session ends, for example when you sign out.'
    ],
    // Where an S3-compatible store keeps the files (at), who can open them there (who) and the sentence that says who
    // keeps them (keeps), from the provider and the place the operator set (WORKSPACE_FILES_S3_PROVIDER and
    // WORKSPACE_FILES_S3_PLACE). While either is missing, the words fit any service, one the operator runs itself
    // included, so they name no data processing terms.
    s3Keeper: (provider, place) =>
      provider && place
        ? { at: `${provider} in ${place}`, who: provider, keeps: `${provider} keeps them on our behalf under its data processing terms.` }
        : { at: 'the S3-compatible service this server uses', who: 'that service', keeps: 'That service keeps them on our behalf.' },
    web: 'In a browser',
    // files: whether the server keeps team chat's files (they then pass through the page too).
    webText: (files) => [
      `This server’s website also runs Rukoo in a browser, at /app/: team chat, signing up and signing in, without installing anything. The browser keeps a few things in this site’s storage on your computer: the server’s address, your email address and the session’s token; your language, theme and whether chat notifications are on, and whether this browser can show them; whether the sidebar is folded, whether the formatting bar shows and whether you closed the notice about the Rukoo apps; the emoji you used last and the skin tone you picked for them; the IDs of the workspaces you are in and of the conversation you last had open in each; for each open tab, how many messages it still has to send; and, in the tab alone, the invitation link it was opened with until you use it. They are there because the page needs them to work, not to follow you: the site sets no cookies and runs no analytics. Messages and drafts are only in the page’s memory, and go when you close it.${files ? ' So are the files you attach and the ones the page downloads to show them to you: closing the page clears them. An image you open in a new tab stays in that tab until you close it. A file you download is a copy your browser saves on your device, and it stays there.' : ''}`,
      'Signing out removes the session, the invitation link and the counts of messages still to send. The rest stays in the browser, without names or messages, so Chat opens where you were, as you set it up, when you sign in again.',
      'The server knows a session made in a browser as one, and lets it use team chat, see the account and its devices, sign devices out, sign out and delete the account. It can’t read or change your encrypted records or use your booking page. The browser never keeps your password or your data key, and doesn’t show What’s stored and shared or Export my data, nor change your password or recovery key; use the Rukoo app for those.',
      'The page’s code comes from this site each time you open it. Whoever runs the site, or someone who broke into it, could change that code to read your password as you type it, and with it open your encrypted records. The Rukoo apps run the code you installed. If that matters to you, use team chat in one of them.'
    ],
    webSecurity: 'In a browser that holds only as long as the page’s code is what this site published (see In a browser).',
    security: 'Security',
    securityText: (protocol) =>
      `Your password goes through Argon2id on your device, and your records are encrypted with AES-256-GCM before they leave it. We can’t reset your password: without your password or your recovery key, nobody can open your records, including us. ${protocol} describes exactly how it works.`,
    protocol: 'The Rukoo account protocol',
    changes: 'Changes',
    changesText: 'When this statement changes in a way that matters to you, the date at the top changes too.'
  },
  nl: {
    title: 'Privacyverklaring voor Rukoo-accounts',
    updated: (date) => `Laatst bijgewerkt op ${date}.`,
    other: '<a href="/privacy?lang=en">English</a>',
    who: 'Wie is verantwoordelijk',
    whoText: (op) => `${op} beheert deze server en bepaalt wat er met je gegevens gebeurt.`,
    unnamed: 'De beheerder van deze server heeft geen naam ingevuld. Die bepaalt wat er met je gegevens gebeurt.',
    contact: (c) => ` Contact: ${c}.`,
    what: 'Wat deze dienst is',
    whatText:
      'Een Rukoo-account houdt je inboxcategorieën, de categorie van elke e-mail en je correcties gelijk op je apparaten met Rukoo, de opensource-mailapp. Als je het aanzet, draait het ook je afsprakenpagina, waar anderen en hun AI-assistenten een afspraak met je kunnen maken. Je e-mail, je e-mailwachtwoorden en je Google-aanmeldingen gaan nooit door deze server.',
    whatChat:
      'Deze server draait ook teamchat: werkruimtes waarin je met anderen praat in kanalen en directe berichten. Anders dan je records is teamchat op deze server leesbaar (zie Teamchat).',
    data: 'Wat we bewaren',
    dataItems: [
      'Je e-mailadres, waarmee je inlogt. We sturen er geen mail naar en controleren het niet.',
      'Een controlewaarde die je apparaat uit je wachtwoord afleidt. Daarmee kan de server je wachtwoord controleren; het is niet je wachtwoord, en de server kan er geen wachtwoord van terugmaken.',
      'Je versleutelde records. Je apparaten versleutelen ze met een sleutel die alleen zij hebben, dus wij kunnen ze niet lezen: niet je categorieën, niet je correcties, niet welke e-mail waar terechtkwam.',
      'Je versleutelde gegevenssleutel, ingepakt met je wachtwoord en met je herstelsleutel. Wij kunnen hem niet openen.',
      'De namen en platforms van je apparaten, wanneer elk ervan inlogde en wanneer het voor het laatst verbinding had.',
      'Hoeveel records je hebt, hoe groot ze zijn en wanneer ze veranderen.',
      'Mislukte inlogpogingen, om inloggen met een adres na tien daarvan 15 minuten te blokkeren. We tellen ze onder een hash van het adres, ook voor een adres zonder account, en verwijderen ze als de blokkade voorbij is of 15 minuten na de eerste poging. Verkeerde wachtwoorden op een ingelogd apparaat tellen alleen voor dat apparaat.',
      'Als je een afsprakenpagina aanzet: wat die publiceert en de afspraken die erop worden gemaakt, zoals hieronder bij Afsprakenpagina’s staat.'
    ],
    dataChat: 'Als je teamchat gebruikt: de werkruimtes waarin je zit en wat je daar schrijft en doet, zoals hieronder bij Teamchat staat.',
    emailItem: (signup) =>
      signup
        ? 'Je e-mailadres, waarmee je inlogt. Tenzij je een account maakt met een uitnodigingscode van ons, controleren we het met een code die we ernaartoe sturen voordat we je account maken. We sturen er geen andere mail naar dan de codes die je aanvraagt (zie E-mailcodes).'
        : 'Je e-mailadres, waarmee je inlogt. We controleren het niet en sturen er geen andere mail naar dan de codes die je aanvraagt (zie E-mailcodes).',
    lockCodes: ' Met een code die naar je e-mailadres wordt gestuurd, kun je tijdens de blokkade toch inloggen of je account herstellen.',
    codes: 'E-mailcodes',
    codesText: (signup) => [
      `${signup ? 'Je kunt deze server om een code van zes cijfers per e-mail vragen: om een account te maken, en om in te loggen of je account te herstellen terwijl het door mislukte pogingen geblokkeerd is.' : 'Je kunt deze server om een code van zes cijfers per e-mail vragen, om in te loggen of je account te herstellen terwijl het door mislukte pogingen geblokkeerd is.'} De code van zes cijfers werkt één keer, 10 minuten lang, op het apparaat dat erom vroeg. In elke e-mail staat ook een langere code die één keer werkt, op elk apparaat, een dag lang. Zo kun je elke e-mail gebruiken die je krijgt, ook een die iemand anders aanvroeg.`,
      'Resend, een dienst van Resend, Inc. in de Verenigde Staten, verstuurt deze e-mails namens ons onder zijn verwerkersvoorwaarden. Resend krijgt je e-mailadres en de e-mail, met de codes erin, slaat ze op in de Verenigde Staten en bewaart ze 30 dagen bij zijn gewone abonnementen.',
      `Wie een code aanvraagt, krijgt hetzelfde antwoord of het adres nu een account heeft of niet, dus dat valt er niet uit af te leiden.${signup ? ' Vraag je een code om een account te maken voor een adres dat al een account heeft, dan staat dat in de e-mail, in plaats van een code.' : ''} Een adres zonder account krijgt geen inlogcode.`,
      `Voor elke code die iemand aanvraagt, bewaart deze server hashes van het adres, van beide codes en van een willekeurige waarde die het aanvragende apparaat terugkreeg, hoeveel verkeerde pogingen er waren, of de e-mail uitging en wanneer de codes verlopen. Het adres zelf bewaart hij niet. Dat alles wordt verwijderd als een code is gebruikt, na vijf verkeerde wachtwoorden of herstelsleutels ermee, een dag nadat hij werd aangevraagd, of na 10 minuten als er geen e-mail met de codes uitging. Om te beperken hoeveel codes één adres krijgt (één per minuut, vijf per uur en tien per dag, apart voor een account maken en voor inloggen), bewaart hij ook wanneer er codes voor een adres werden aangevraagd, onder een hash van het adres, tot een dag na de laatste keer. Beide bewaart hij ook als er geen e-mail uitgaat omdat het adres geen account heeft. Om te beperken hoeveel inlogmails één mailbox en één adres krijgen, bewaart hij een dag lang wanneer die uitgingen, onder een hash van de mailbox of het adres.${signup ? ' Om te beperken hoeveel accounts de adressen van één domein per dag maken, telt hij de accounts die daar met een code zijn gemaakt, onder een hash van het domein, tot de dag voorbij is. Bereikt een domein die grens, dan noemt de server dat domein, zonder adres, in zijn log, en in een e-mail aan wie hem beheert als die daarom vroeg, zodat een e-mailprovider die niet beperkt hoort te worden alsnog door kan.' : ''} Je IP-adres bewaart hij hiervoor niet.`,
      signup
        ? 'We sturen codes om het account te maken waar je om vraagt en om je binnen te laten terwijl een blokkade anderen buitenhoudt (de overeenkomst met jou, artikel 6 lid 1 onder b AVG). Het controleren van adressen en de limieten op codes beschermen mensen tegen accounts die met hun adres worden gemaakt, en de dienst tegen misbruik (een gerechtvaardigd belang, artikel 6 lid 1 onder f AVG).'
        : 'We sturen codes om je binnen te laten terwijl een blokkade anderen buitenhoudt (de overeenkomst met jou, artikel 6 lid 1 onder b AVG). De limieten op codes beschermen mensen en de dienst tegen misbruik (een gerechtvaardigd belang, artikel 6 lid 1 onder f AVG).'
    ],
    whereCodes: 'Resend, een dienst van Resend, Inc. in de Verenigde Staten, verstuurt de e-mails met codes en bewaart ze daar (zie E-mailcodes).',
    ip: 'Bij elk verzoek komt je IP-adres bij Cloudflare binnen. De server gebruikt het om te beperken hoe vaak één adres mag proberen in te loggen of iets naar een afsprakenpagina mag sturen, en slaat het niet op. Voor afspraken telt de server ook hoeveel er die dag van één netwerk kwamen (een IPv4-/24 of een IPv6-/64). Die tellingen bewaart hij alleen als hashes, gemaakt met een sleutel die elke dag wisselt, en hij verwijdert ze zodra de dag van de host voorbij is. Cloudflare kan adressen kort in zijn eigen logs bewaren.',
    why: 'Waarom',
    whyText:
      'We gebruiken deze gegevens om je het account te geven waar je om vroeg: inloggen, je apparaten synchroniseren en je apparaten en gebruik tonen (de overeenkomst met jou, artikel 6 lid 1 onder b AVG). Snelheidslimieten en de inlogblokkade beschermen je account en de dienst (een gerechtvaardigd belang, artikel 6 lid 1 onder f AVG). We gebruiken ze nergens anders voor: geen analyses, geen advertenties, geen profielen, en we verkopen of delen ze niet.',
    where: 'Waar het staat, en wie helpt',
    whereText: (place) =>
      `De server draait op Cloudflare, een dienst van Cloudflare, Inc. in de Verenigde Staten, dat de gegevens namens ons verwerkt onder zijn verwerkersvoorwaarden. ${place} Omdat Cloudflare een Amerikaans bedrijf is, valt het onder Amerikaans recht, ook voor gegevens in de EU. Wat het zou kunnen moeten afgeven, is de lijst hierboven: je records blijven versleuteld met een sleutel die Cloudflare niet heeft. Een afsprakenpagina is anders: wat die publiceert is leesbaar, en de gegevens van een gast ook, op het moment dat die boekt (zie Afsprakenpagina’s).`,
    whereChat: (files, agents) =>
      `Teamchat is ook leesbaar: de werkruimtes, ${files ? 'wie erin zitten, hun berichten en bestanden' : 'wie erin zitten en hun berichten'} (zie Teamchat).${files?.s3 ? ` De bestanden staan bij ${files.s3.at}.` : ''}${agents ? ' Een agent in een kanaal geeft wat hij daar leest door aan een programma dat zijn sponsor koos, en dat programma hoort niet bij deze server (zie Teamchat).' : ''}`,
    places: {
      eu: 'Accounts worden opgeslagen en verwerkt in de Europese Unie.',
      us: 'Accounts worden opgeslagen en verwerkt in de Verenigde Staten.',
      fedramp: 'Accounts worden opgeslagen en verwerkt in FedRAMP-Moderate-datacenters in de Verenigde Staten.',
      any: 'Elk account staat op één Cloudflare-locatie, meestal dicht bij het apparaat dat het maakte.'
    },
    keep: 'Hoe lang',
    keepText: (days) =>
      `We bewaren je account tot je het verwijdert. Account verwijderen in Rukoo (Instellingen, Rukoo-account) verwijdert het account, alle records en je afsprakenpagina met de afspraken erop in één keer. Cloudflare bewaart back-ups van de opslag waarmee de toestand van tot 30 dagen eerder terug te halen is, dus na die tijd zijn verwijderde gegevens helemaal weg. ${
        days
          ? `Een account dat nooit wordt gebruikt, verwijderen we ${days} dagen nadat het is gemaakt, zodat het geen plek inneemt die iemand anders nodig heeft: een account dat nooit een record heeft opgeslagen, nooit in een werkruimte zat, nooit een afsprakenpagina had, en waarop na de dag waarop het is gemaakt geen apparaat meer heeft ingelogd of verbinding heeft gemaakt. Andere inactieve accounts worden niet vanzelf verwijderd; vraag het ons als je het jouwe weg wilt hebben en niet meer kunt inloggen.`
          : 'Inactieve accounts worden niet vanzelf verwijderd; vraag het ons als je het jouwe weg wilt hebben en niet meer kunt inloggen.'
      }`,
    rights: 'Je rechten',
    rightsText:
      'Je ziet wat er over je is opgeslagen op de pagina Wat er wordt opgeslagen en gedeeld in Rukoo, je exporteert alles met Mijn gegevens exporteren, en je wijzigt je wachtwoord en verwijdert je account zelf. Voor al het andere, zoals een kopie van de gegevens die we hebben of een bezwaar, neem je contact met ons op. Je kunt ook een klacht indienen bij een toezichthouder, zoals de Autoriteit Persoonsgegevens of die in het land waar je woont. Heb je via een afsprakenpagina een afspraak met iemand gemaakt? Onder Afsprakenpagina’s staat wat je kunt doen.',
    rightsChat: 'Die pagina en Mijn gegevens exporteren gaan niet over teamchat; onder Teamchat staat wat je daar kunt doen.',
    booking: 'Afsprakenpagina’s',
    bookingText: [
      'Met een afsprakenpagina, op een adres dat eindigt op een naam die de accounthouder kiest, kunnen anderen en hun AI-assistenten een afspraak maken met die accounthouder: de host. De pagina staat uit tot de host hem in Rukoo aanzet. Zolang hij aanstaat, bewaart deze server leesbaar wat de host publiceert, omdat hij ook tijden moet kunnen aanbieden als de computers van de host uitstaan: de naam van de host, de introductie, tijdzone en taal, de soorten afspraken met hun openbare locaties, een eventueel contactbericht, de uren waarop de host beschikbaar is en de bezette tijden daarbinnen (per kwartier, zonder titels of andere details), en wanneer de pagina voor het laatst is bijgewerkt. De pagina laat de vrije tijden zien, nooit de bezette tijden zelf.',
      'Boek je via een afsprakenpagina, dan ben je gast. Je geeft je naam, je e-mailadres, eventueel een opmerking en, als een assistent voor je boekt, de naam van die assistent. Die gaan naar de host: Rukoo zet de afspraak in de agenda van de host, en de agenda- en mailprovider van de host, zoals Google, stuurt je de uitnodiging. Daarna bepaalt de host wat er met je gegevens gebeurt. Rukoo bewaart bij de host een eigen kopie, end-to-end versleuteld, en verwijdert die 30 dagen na de afspraak; de afspraak zelf blijft in de agenda van de host staan, zoals elke andere.',
      'We verwerken de gegevens van een gast om de afspraak te maken waar de gast om vraagt, namens de host (stappen op verzoek van de gast, artikel 6 lid 1 onder b AVG). Limieten op hoe vaak en vanaf waar er wordt geboekt, beschermen hosts en de dienst (een gerechtvaardigd belang, artikel 6 lid 1 onder f AVG).',
      'Deze server leest de gegevens van een gast één keer, bij het boeken, om ze te verzegelen: hij versleutelt ze met een sleutel die alleen de apparaten van de host hebben, en bewaart alleen die verzegelde kopie. Een later datalek, een back-up of een inbraak achteraf maakt ze dus niet zichtbaar. Maar op het moment van boeken gaan de gegevens leesbaar door de server. De beheerder, of iemand die op dat moment heeft ingebroken, zou ze dan kunnen lezen. Naast de verzegelde kopie bewaart de server de tijd, de soort afspraak en de status, hoe er is geboekt (via de webpagina, de JSON-API of MCP), een hash van de sleutel in de beheerlink van de gast en, zolang de afspraak loopt, een hash van het e-mailadres van de gast, gekoppeld aan die tijd, zodat dezelfde afspraak niet twee keer wordt gemaakt.',
      'Een afspraak blijft op deze server tot 30 dagen na de afspraak. Annuleert de gast, weigert de host of verloopt een verzoek, dan worden de verzegelde gegevens en de hash van het e-mailadres meteen verwijderd, en de rest 30 dagen later. Zet de host de pagina uit of verwijdert de host het account, dan worden de pagina en alle afspraken erop verwijderd.',
      'Een gast kan de afspraak zelf annuleren met de link op de pagina die na het boeken verscheen; daarmee verdwijnen de gegevens meteen van deze server. Voor wat de host met je gegevens doet, neem je contact op met de host. Voor de kopie op deze server neem je contact met ons op.',
      'Hosts schrijven hun eigen pagina; wij controleren die niet. Doet een pagina zich voor als iemand anders, of is hij kwetsend? Gebruik dan Pagina melden onderaan de pagina, of neem contact met ons op.'
    ],
    chat: 'Teamchat',
    chatText: (days, signups, previews, files, agents, push) => [
      'Met teamchat maken mensen met een account op deze server werkruimtes, waarin ze praten in kanalen en directe berichten. Voor elke werkruimte waarin je zit, bewaart deze server de naam die je daar gebruikt, je rol, wanneer je erbij kwam en wegging, de kanalen en directe berichten waarin je zit, hoe ver je in elk ervan hebt gelezen, hoe vaak je daar een bericht als ongelezen hebt gemarkeerd, en de berichten die je schrijft, met de mensen die je erin noemt en, bij een antwoord in een thread, het bericht waarop het antwoordt. Reageer je met een emoji op een bericht, dan bewaart hij welke emoji je gebruikte en wanneer. Ook bewaart hij wie je blokkeert, de uitnodigingen die je maakt, een ID dat je apparaat aan elk bericht geeft, zodat een nieuwe poging het niet twee keer plaatst, en wanneer je directe berichten begon, om te beperken hoeveel je er begint; die tijden zijn na een dag aan de beurt voor verwijdering.',
      'Teamchat is niet end-to-end versleuteld, anders dan je records. Berichten worden opgeslagen zoals ze zijn geschreven. Wij kunnen ze dus lezen en wijzigen, in kanalen en in directe berichten, en Cloudflare ook. We zien ook wie in welk gesprek zit. We verwerken teamchat om je de werkruimtes te geven die je maakt of waaraan je deelneemt (de overeenkomst met jou, artikel 6 lid 1 onder b AVG).',
      ...(previews
        ? [
            `Staan er webadressen in een bericht, dan haalt deze server tot drie van die pagina’s op en voegt hij van elk een linkvoorbeeld aan het bericht toe, met de titel van de pagina, een korte beschrijving en de naam van de site${files ? ', en de afbeelding van de pagina, die hij als bestand bij het bericht bewaart' : ''}. De site ziet een verzoek van deze server, niet jouw IP-adres. Een voorbeeld blijft bij zijn bericht, en de gegevens ervan komen ook in een aparte gebeurtenis in de geschiedenis van het gesprek: het adres, de titel, de beschrijving en de naam van de site, of de pagina een video is${files ? ', en de bestands-ID, de naam, het type, de grootte en de afmetingen van de afbeelding' : ''}. Verwijdert iemand het bericht, dan verdwijnen de voorbeelden uit beide. Haalt de schrijver van het bericht een voorbeeld weg, dan is het niet meer te zien${files ? ' en wordt de afbeelding ervan verwijderd' : ''}, maar de gegevens ervan kunnen in de geschiedenis blijven staan. Gegevens van voorbeelden in de geschiedenis kunnen ook langer blijven dan hun bericht, tot die gebeurtenissen met de rest worden verwijderd.`
          ]
        : []),
      ...(files
        ? [
            files.s3
              ? `Bestanden die je in teamchat verstuurt, staan in niet-openbare opslag bij ${files.s3.at}, met hun naam, type en grootte. Deze server bewaart ook hun naam, type, grootte en een hash van de inhoud, en bij een afbeelding de breedte en hoogte. ${files.s3.keeps} Net als berichten zijn ze niet end-to-end versleuteld. Wij kunnen ze dus openen, en ${files.s3.who} ook. Een bestand mag tot ${files.max} groot zijn, en alle bestanden in een werkruimte samen tot ${files.total}. Je apparaten uploaden en downloaden ze via deze server, die op Cloudflare draait, dus onderweg gaan ze leesbaar door Cloudflare. Alleen wie het bericht kan lezen, krijgt een downloadlink, en die werkt 60 seconden. Een bestand wordt uit de opslag verwijderd, meestal binnen een minuut, als iemand het bericht verwijdert of als het bericht zelf wordt verwijderd. Een bestand dat niet wordt verstuurd, is een uur nadat het uploaden begon aan de beurt voor verwijdering. Wordt een werkruimte verwijderd, dan verdwijnen ook de bestanden erin.`
              : `Bestanden die je in teamchat verstuurt, staan in niet-openbare opslag bij Cloudflare R2, met hun naam, type, grootte en een hash van de inhoud, en bij een afbeelding de breedte en hoogte. Net als berichten zijn ze niet end-to-end versleuteld. Wij kunnen ze dus openen, en Cloudflare ook. Een bestand mag tot ${files.max} groot zijn, en alle bestanden in een werkruimte samen tot ${files.total}. Je apparaten uploaden en downloaden ze via deze server. Alleen wie het bericht kan lezen, krijgt een downloadlink, en die werkt 60 seconden. Een bestand wordt uit de opslag verwijderd, meestal binnen een minuut, als iemand het bericht verwijdert of als het bericht zelf wordt verwijderd. Een bestand dat niet wordt verstuurd, is een uur nadat het uploaden begon aan de beurt voor verwijdering. Wordt een werkruimte verwijderd, dan verdwijnen ook de bestanden erin.`
          ]
        : []),
      'Binnen een werkruimte zien eigenaren, beheerders en leden de naam en rol van iedereen erin en van mensen die zijn vertrokken. Gasten zien de mensen in de kanalen waarin ze zitten. Leden kunnen elk kanaal vinden dat voor de hele werkruimte zichtbaar is en eraan deelnemen, en wie aan een kanaal deelneemt, kan ook de eerdere berichten lezen. Gasten zien alleen de kanalen waaraan ze zijn toegevoegd. Alleen de mensen in een privékanaal zien de naam en de berichten ervan, en alleen de mensen in een direct bericht zien dat gesprek. Eigenaren en beheerders zien de uitnodigingen die nog openstaan. Wie je blokkeert, krijgt dat niet te horen, maar kan wel merken dat een direct bericht met jou is gesloten of dat een nieuw niet lukt.',
      ...(agents
        ? [
            'Eigenaren, beheerders en leden kunnen agents maken: accounts in de werkruimte waar een programma voor antwoordt, zoals een AI-assistent. Wie er een maakt, is de sponsor ervan en kiest dat programma, dat buiten deze server draait: bijvoorbeeld op de eigen computer van de sponsor, of bij een dienst die de sponsor koos. Een agent staat in de werkruimte zoals een persoon, aangeduid als agent. Kanaalbeheerders kunnen hem aan hun kanaal toevoegen, en zijn sponsor kan hem toevoegen aan een kanaal dat voor de hele werkruimte zichtbaar is en waarin de sponsor zelf zit. In een privékanaal kan hij alleen zitten zolang zijn sponsor erin zit, en hij verlaat dat kanaal als zijn sponsor dat doet. In elk kanaal waarin hij zit, kan hij lezen wat een persoon daar kan lezen: de berichten, ook de eerdere, hun bestanden en wie er in het kanaal zitten. Wat hij leest, geeft hij door aan dat programma, dat het weer kan doorsturen naar de aanbieder van een AI-model. Deze server kan dat programma niet zien of sturen, en wat er daar gebeurt met wat de agent leest, bepalen de sponsor en wie het programma draait, niet wij. Een agent plaatst alleen een bericht als antwoord op een bericht waarin hij wordt genoemd, en bij elk antwoord controleert deze server of de agent de schrijver van dat bericht mag antwoorden, of, als een andere agent het schreef, de persoon die dat gesprek begon.',
            'Van elke agent bewaart deze server de naam, de sponsor, wie hij antwoordt, of hij andere agents antwoordt, wanneer hij is gemaakt, wanneer hij de server voor het laatst gebruikte, een hash van zijn sleutel en, bij elk antwoord, het bericht waarop het antwoordt. Eigenaren, beheerders en leden zien wanneer elke agent de server voor het laatst gebruikte. De sleutel van een agent is geheim, net als een wachtwoord: wie hem heeft, kan de kanalen van de agent lezen en er als de agent in schrijven. Alleen de sponsor kan een nieuwe sleutel maken, waarmee de oude meteen niet meer werkt. De sponsor, een eigenaar of een beheerder kan de agent verwijderen, en de sponsor kan verwijderen wat de agent schreef. Een agent wordt ook verwijderd als zijn sponsor de werkruimte verlaat, eruit wordt verwijderd, gast wordt of het eigen account verwijdert. Bij het verwijderen van een agent verdwijnt de hash van zijn sleutel. Zijn naam en instellingen blijven in de werkruimte staan, zoals bij een vertrokken lid, en wat hij schreef, blijft staan tot het met de rest wordt verwijderd.'
          ]
        : []),
      ...(push
        ? [
            'Rukoo voor Android kan deze server vragen hem te wekken als er iets binnenkomt waarvan je een melding zou krijgen, een direct bericht, een vermelding of een antwoord op je bericht, zodat de melding ook komt als de app dicht is. De telefoon geeft deze server dan het adres van de pushdienst die hij gebruikt, zoals ntfy, en de sleutels om ervoor te versleutelen. Deze server bewaart ze bij die sessie en verwijdert ze als de sessie eindigt, bijvoorbeeld als je uitlogt, of als die telefoon meldingen voor teamchat uitzet. Een wekbericht is versleuteld voor je telefoon en zegt alleen dat er iets nieuws is: geen werkruimte, gesprek, naam of tekst. De telefoon haalt het nieuwe daarna zelf bij deze server op. De pushdienst ziet dat er een wekbericht naar je telefoon ging en wanneer, en wordt onder eigen voorwaarden beheerd door wie hem draait, niet door ons. Op een telefoon zonder zo’n app gebruikt Rukoo voor Android Firebase Cloud Messaging van Google, via Google Play-services, als pushdienst. Google LLC krijgt dan bij elk wekbericht van deze server het token dat Google die telefoon gaf, ziet wanneer er een wekbericht wordt verstuurd en bewaart het versleutelde wekbericht tot de telefoon het ophaalt, hooguit een dag. Google kan het wekbericht niet lezen, en het zegt sowieso niets over je berichten. Google beheert die dienst onder eigen voorwaarden, ook buiten de EU. We sturen wekberichten om je de meldingen te geven die je hebt aangezet (de overeenkomst met jou, artikel 6 lid 1 onder b AVG).'
          ]
        : []),
      `Een uitnodiging is een link met een geheim erin. Wie de link heeft, kan hem één keer gebruiken, zolang hij werkt: een dag, tenzij de maker tot zeven dagen kiest. Stuur hem dus alleen naar degene voor wie hij bedoeld is. In de werkruimte bewaart deze server een hash van het geheim, wie de uitnodiging maakte, de rol en kanalen die ze geeft, wanneer ze verloopt en wie haar gebruikte. Die gegevens zijn 30 dagen na het verlopen van de uitnodiging aan de beurt voor verwijdering. Een uitnodiging werkt niet meer als ze is ingetrokken, of als de maker vertrekt of niet meer mag uitnodigen.${signups ? ` Op deze server werkt een uitnodiging ook als uitnodigingscode: iemand zonder account kan er een account mee maken, één per uitnodiging.${signups === 'checked' ? ' Wel bevestigt die eerst het e-mailadres, met een code die we ernaartoe sturen.' : ''} Daarvoor houdt de server apart bij met welke uitnodigingen iemand een account maakte of probeerde te maken: een hash van het geheim en hoeveel accounts ermee zijn gemaakt. Dat bewaart hij zonder einddatum, ook als het aanmaken mislukte of het account later wordt verwijderd, zodat een uitnodiging geen tweede account maakt.` : ''}`,
      `Berichten zijn aan de beurt voor verwijdering ${days === 1 ? 'een dag' : `${days} dagen`} nadat ze zijn geschreven, samen met de andere gebeurtenissen in elk gesprek, zoals wie erbij kwam of reageerde. Een opruimronde draait minstens één keer per dag en verwijdert wat aan de beurt is; een ronde die mislukt, wordt later opnieuw geprobeerd. Een bericht dat iemand verwijdert, verliest meteen zijn tekst en reacties, en daarbij worden ook de gegevens gewist over wie er met welke emoji op reageerde. Een gearchiveerd kanaal of een gesloten direct bericht verdwijnt zodra er niets meer in staat. De server onthoudt welke berichten zijn verwijderd en wie de toegang tot welk gesprek verloor, zodat apparaten die weg waren kunnen bijwerken; dat is na veertien dagen aan de beurt voor verwijdering. Een eigenaar die als enige in een werkruimte zit, kan die verwijderen; dan verdwijnt alles erin in één keer. De back-ups van 30 dagen onder Hoe lang gelden hier ook: zo lang kunnen verwijderde berichten worden teruggehaald.`,
      'Verlaat je een werkruimte of word je eruit verwijderd, dan verlies je de toegang tot de kanalen en directe berichten erin, sluiten je directe berichten daar en werken je openstaande uitnodigingen niet meer. Wat je schreef, blijft staan onder je naam, tot het met de rest wordt verwijderd. Je account houdt een lijst bij van de werkruimtes waarin je zit of zat, zodat elk ervan hoort wanneer je je account verwijdert. Verwijder je het, dan verlaat je elke werkruimte waarin je nog zit, verdwijnt je naam van wat je schreef, dat daarna op naam van een verwijderd lid staat, en worden alle blokkades verwijderd die je maakte of kreeg. De berichten zelf blijven staan tot hun werkruimte ze verwijdert. Een werkruimte waarin je als enige zit, blijft zonder iemand erin op de server staan. De berichten verdwijnen als ze met de rest worden verwijderd, maar de naam blijft. Verwijder hem dus eerst in Rukoo als je hem meteen weg wilt hebben. Tot elke werkruimte van het verwijderen heeft gehoord, bewaart de server alleen de ID van die werkruimte en een willekeurige ID van je account, zonder je e-mailadres, inloggegevens of records. Elke werkruimte bewaart die willekeurige ID daarna tot hij na 30 dagen aan de beurt is voor verwijdering, zodat niets wat nog onderweg was er alsnog mee binnenkomt.',
      'In Rukoo verander je zelf je naam in een werkruimte, verwijder je je eigen berichten en verlaat je een werkruimte. Mijn gegevens exporteren neemt teamchat niet mee. Elk van je apparaten houdt een eigen kopie van teamchat bij en verwijdert die als de sessie eindigt, bijvoorbeeld als je uitlogt.'
    ],
    s3Keeper: (provider, place) =>
      provider && place
        ? { at: `${provider} in ${place}`, who: provider, keeps: `${provider} bewaart ze namens ons onder zijn verwerkersvoorwaarden.` }
        : { at: 'de S3-compatibele dienst die deze server gebruikt', who: 'die dienst', keeps: 'Die dienst bewaart ze namens ons.' },
    web: 'In een browser',
    webText: (files) => [
      `De website van deze server draait Rukoo ook in een browser, op /app/: teamchat, een account maken en inloggen, zonder iets te installeren. De browser bewaart een paar dingen in de opslag van deze site op je computer: het adres van de server, je e-mailadres en het token van de sessie; je taal, thema en of chatmeldingen aanstaan, en of deze browser ze kan tonen; of de zijbalk is ingeklapt, of de opmaakbalk zichtbaar is en of je de melding over de Rukoo-apps hebt gesloten; de emoji die je het laatst gebruikte en de huidskleur die je ervoor koos; de ID’s van de werkruimtes waarin je zit en van het gesprek dat je in elk ervan het laatst open had; per open tabblad hoeveel berichten het nog moet versturen; en, alleen in dat tabblad, de uitnodigingslink waarmee het werd geopend, tot je die gebruikt. Ze staan er omdat de pagina ze nodig heeft om te werken, niet om je te volgen: de site zet geen cookies en doet geen analyses. Berichten en concepten staan alleen in het geheugen van de pagina, en verdwijnen als je die sluit.${files ? ' Dat geldt ook voor de bestanden die je toevoegt en de bestanden die de pagina downloadt om ze je te laten zien: sluit je de pagina, dan zijn ze weg. Een afbeelding die je in een nieuw tabblad opent, blijft in dat tabblad tot je het sluit. Een bestand dat je downloadt, is een kopie die je browser op je apparaat opslaat, en die blijft staan.' : ''}`,
      'Uitloggen verwijdert de sessie, de uitnodigingslink en de tellingen van berichten die nog moeten worden verstuurd. De rest blijft in de browser staan, zonder namen of berichten, zodat Chat opent waar je was en zoals je het had ingesteld als je weer inlogt.',
      'De server kent een sessie die in een browser is gemaakt als zodanig, en laat die teamchat gebruiken, het account en de apparaten erin tonen, apparaten afmelden, uitloggen en het account verwijderen. Zo’n sessie kan je versleutelde records niet lezen of wijzigen en je afsprakenpagina niet gebruiken. De browser bewaart nooit je wachtwoord of je gegevenssleutel, en toont Wat er wordt opgeslagen en gedeeld en Mijn gegevens exporteren niet, en wijzigt je wachtwoord of herstelsleutel niet; gebruik daarvoor de Rukoo-app.',
      'De code van de pagina komt elke keer dat je hem opent van deze site. Wie de site beheert, of iemand die erop heeft ingebroken, zou die code zo kunnen veranderen dat hij je wachtwoord leest terwijl je het typt, en daarmee je versleutelde records openen. De Rukoo-apps draaien de code die je hebt geïnstalleerd. Vind je dat belangrijk, gebruik teamchat dan in een van de apps.'
    ],
    webSecurity: 'In een browser geldt dat alleen zolang de code van de pagina is wat deze site publiceerde (zie In een browser).',
    security: 'Beveiliging',
    securityText: (protocol) =>
      `Je wachtwoord gaat op je apparaat door Argon2id, en je records worden met AES-256-GCM versleuteld voordat ze het verlaten. We kunnen je wachtwoord niet resetten: zonder je wachtwoord of je herstelsleutel kan niemand je records openen, wij ook niet. ${protocol} beschrijft precies hoe het werkt.`,
    protocol: 'Het Rukoo-accountprotocol',
    changes: 'Wijzigingen',
    changesText: 'Als deze verklaring verandert op een manier die voor jou uitmaakt, verandert de datum bovenaan ook.'
  }
};

// The language asked for with ?lang=, or else the browser's first choice of English and Dutch.
export function privacyLanguage(url, acceptLanguage) {
  return language(url.searchParams.get('lang'), acceptLanguage);
}

// asked when it is English or Dutch, else the first of those two in an Accept-Language header, else English.
export function language(asked, acceptLanguage) {
  if (asked === 'nl' || asked === 'en') return asked;
  for (const part of String(acceptLanguage || '').split(',')) {
    const tag = part.trim().slice(0, 2).toLowerCase();
    if (tag === 'nl' || tag === 'en') return tag;
  }
  return 'en';
}

function contactLink(value) {
  if (!value) return '';
  return /^[^\s@]+@[^\s@]+$/.test(value) ? `<a href="mailto:${escape(value)}">${escape(value)}</a>` : link(value, value);
}

// A number of bytes as the limits are written in the docs, such as 25 MiB or 5 GiB.
function bytesText(bytes, lang) {
  for (const [unit, size] of [
    ['GiB', 1024 ** 3],
    ['MiB', 1024 ** 2],
    ['KiB', 1024]
  ]) {
    if (bytes >= size) return `${new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }).format(bytes / size)} ${unit}`;
  }
  return `${bytes} bytes`;
}

// chat: null while team chat is off, else { retentionDays, inviteSignups, previews, files, agents, push } (index.js), files
// null without a files bucket and else { store, maxBytes, workspaceBytes }, with provider and place when store is 's3'
// (config.js, filesStorage). agents is whether members can add agents (config.js, agentsOn); it counts as on unless it
// is false, as agents are on wherever team chat is unless WORKSPACE_AGENTS turns them off. push is whether the server
// sends push wakes (WORKSPACE_PUSH, webpush.js). The statement mentions team
// chat only on a server that runs it, and link previews, files and agents only where the server has them. web: Rukoo in the browser runs on this server's website (WEB_APP,
// with team chat on), which the statement then covers too. codes: what the server sends codes by email for (codes.js,
// codePurposes). With none, the statement says the server sends no mail. expireDays: EXPIRE_UNUSED_DAYS, after which
// accounts that are never used are deleted, which the statement says while it is set; 0 when it isn't.
export function privacy({ operator, jurisdiction, chat = null, web = false, codes = [], expireDays = 0 }, lang = 'en') {
  const T = TEXT[lang] || TEXT.en;
  const who = operator.name ? T.whoText(link(operator.url, operator.name)) : escape(T.unnamed);
  const contact = operator.contact ? T.contact(contactLink(operator.contact)) : '';
  const place = T.places[jurisdiction] || T.places.any;
  const mailed = codes.length > 0;
  const signupCodes = codes.includes('signup');
  // The address is the first item and the sign-in lock the seventh.
  const accountItems = mailed
    ? T.dataItems.map((item, i) => (i === 0 ? T.emailItem(signupCodes) : i === 6 ? `${item}${T.lockCodes}` : item))
    : T.dataItems;
  const dataItems = chat ? [...accountItems, T.dataChat] : accountItems;
  const files = chat?.files
    ? {
        max: bytesText(chat.files.maxBytes, lang),
        total: bytesText(chat.files.workspaceBytes, lang),
        s3: chat.files.store === 's3' ? T.s3Keeper(chat.files.provider, chat.files.place) : null
      }
    : null;
  const agents = Boolean(chat) && chat.agents !== false;
  const where = [T.whereText(place), ...(mailed ? [T.whereCodes] : []), ...(chat ? [T.whereChat(files, agents)] : [])].join(' ');
  const emailCodes = mailed
    ? `<h2 id="email-codes">${escape(T.codes)}</h2>\n${T.codesText(signupCodes)
        .map((p) => `<p>${escape(p)}</p>`)
        .join('\n')}\n\n`
    : '';
  const teamChat = chat
    ? `<h2 id="team-chat">${escape(T.chat)}</h2>\n${T.chatText(chat.retentionDays, chat.inviteSignups && signupCodes ? 'checked' : chat.inviteSignups, chat.previews, files, agents, Boolean(chat.push))
        .map((p) => `<p>${escape(p)}</p>`)
        .join('\n')}\n\n`
    : '';
  const inBrowser = chat && web;
  const browser = inBrowser
    ? `<h2 id="in-a-browser">${escape(T.web)}</h2>\n${T.webText(Boolean(files))
        .map((p) => `<p>${escape(p)}</p>`)
        .join('\n')}\n\n`
    : '';
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(T.title)}</title>
<style>
body { font: 16px/1.55 system-ui, sans-serif; max-width: 40rem; margin: 2.5rem auto; padding: 0 1.25rem; color: #1f2328; }
h1 { font-size: 1.5rem; } h2 { font-size: 1.1rem; margin-top: 2rem; } a { color: #0b62c4; } li { margin: 0.35rem 0; }
@media (prefers-color-scheme: dark) { body { background: #16181c; color: #e6e8eb; } a { color: #6cb0ff; } }
</style>
</head>
<body>
<h1>${escape(T.title)}</h1>
<p>${escape(T.updated(UPDATED))} ${T.other}</p>

<h2>${escape(T.who)}</h2>
<p>${who}${contact}</p>

<h2>${escape(T.what)}</h2>
<p>${escape(chat ? `${T.whatText} ${T.whatChat}` : T.whatText)}</p>

<h2>${escape(T.data)}</h2>
<ul>
${dataItems.map((item) => `<li>${escape(item)}</li>`).join('\n')}
</ul>
<p>${escape(T.ip)}</p>

<h2>${escape(T.why)}</h2>
<p>${escape(T.whyText)}</p>

<h2>${escape(T.where)}</h2>
<p>${escape(where)}</p>

<h2>${escape(T.keep)}</h2>
<p>${escape(T.keepText(expireDays))}</p>

<h2>${escape(T.rights)}</h2>
<p>${escape(chat ? `${T.rightsText} ${T.rightsChat}` : T.rightsText)}</p>

${emailCodes}<h2 id="booking-pages">${escape(T.booking)}</h2>
${T.bookingText.map((p) => `<p>${escape(p)}</p>`).join('\n')}

${teamChat}${browser}<h2>${escape(T.security)}</h2>
<p>${T.securityText(link(PROTOCOL_URL, T.protocol))}${inBrowser ? ` ${escape(T.webSecurity)}` : ''}</p>

<h2>${escape(T.changes)}</h2>
<p>${escape(T.changesText)}</p>
</body>
</html>
`;
}
