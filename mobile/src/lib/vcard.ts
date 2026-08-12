// Build a standards-compliant vCard 3.0 string from a Calen contact, for the
// contact detail view's Share action (writes a `.vcf` and hands it to the OS
// share sheet). vCard is the universal contact interchange format — Apple/Google
// Contacts, Mail, and messaging apps all import it. Shares the same field set as
// the device-address-book export (lib/deviceContacts); like it, this is a local,
// user-initiated export of the user's own decrypted contact.
import type { LabeledValue } from './contactFields';

export interface VCardInput {
  name: string;
  firstName?: string;
  lastName?: string;
  // 'service' (business) contacts carry no first/last, so N stays name-only.
  type?: string;
  company?: string;
  jobTitle?: string;
  birthday?: string; // YYYY-MM-DD
  phones?: LabeledValue[];
  emails?: LabeledValue[];
  addresses?: LabeledValue[];
  urls?: LabeledValue[];
}

// vCard escaping: backslash, newline, comma, semicolon are structural.
function esc(v: string): string {
  return String(v ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

// `;TYPE=<label>` param for a labeled value (labels are stored lowercase).
function typeParam(label?: string): string {
  const t = String(label ?? '').trim();
  return t ? `;TYPE=${esc(t)}` : '';
}

export function buildVCard(input: VCardInput): string {
  const first = input.firstName?.trim() || '';
  const last = input.lastName?.trim() || '';
  const lines: string[] = ['BEGIN:VCARD', 'VERSION:3.0'];
  // N: Family;Given;Additional;Prefix;Suffix — business contacts have no split.
  lines.push(`N:${esc(last)};${esc(first)};;;`);
  lines.push(`FN:${esc(input.name.trim())}`);
  if (input.company?.trim()) lines.push(`ORG:${esc(input.company.trim())}`);
  if (input.jobTitle?.trim()) lines.push(`TITLE:${esc(input.jobTitle.trim())}`);
  for (const p of input.phones ?? []) {
    if (p.value.trim()) lines.push(`TEL${typeParam(p.label)}:${esc(p.value.trim())}`);
  }
  for (const e of input.emails ?? []) {
    if (e.value.trim()) lines.push(`EMAIL${typeParam(e.label)}:${esc(e.value.trim())}`);
  }
  // ADR: PO;Ext;Street;City;Region;Postal;Country — we store a free-text line, so
  // it goes in the Street component.
  for (const a of input.addresses ?? []) {
    if (a.value.trim()) lines.push(`ADR${typeParam(a.label)}:;;${esc(a.value.trim())};;;;`);
  }
  for (const u of input.urls ?? []) {
    if (u.value.trim()) lines.push(`URL${typeParam(u.label)}:${esc(u.value.trim())}`);
  }
  if (input.birthday && /^\d{4}-\d{2}-\d{2}/.test(input.birthday)) {
    lines.push(`BDAY:${input.birthday.slice(0, 10)}`);
  }
  lines.push('END:VCARD');
  // vCard requires CRLF line breaks.
  return lines.join('\r\n') + '\r\n';
}
