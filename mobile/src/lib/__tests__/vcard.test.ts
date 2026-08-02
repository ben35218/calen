import { buildVCard } from '../vcard';

describe('buildVCard', () => {
  it('emits a well-formed vCard 3.0 with structured name and labeled fields', () => {
    const vcf = buildVCard({
      name: 'Sarah Smith',
      firstName: 'Sarah',
      lastName: 'Smith',
      type: 'friend',
      company: 'Acme',
      jobTitle: 'Engineer',
      birthday: '1990-06-03',
      phones: [{ label: 'mobile', value: '+16045551212' }],
      emails: [{ label: 'home', value: 'sarah@example.com' }],
      addresses: [{ label: 'home', value: '12 Elm St' }],
      urls: [{ label: 'homepage', value: 'https://sarah.example' }],
    });
    const lines = vcf.split('\r\n');
    expect(lines[0]).toBe('BEGIN:VCARD');
    expect(lines[1]).toBe('VERSION:3.0');
    expect(lines).toContain('N:Smith;Sarah;;;');
    expect(lines).toContain('FN:Sarah Smith');
    expect(lines).toContain('ORG:Acme');
    expect(lines).toContain('TITLE:Engineer');
    expect(lines).toContain('TEL;TYPE=mobile:+16045551212');
    expect(lines).toContain('EMAIL;TYPE=home:sarah@example.com');
    expect(lines).toContain('ADR;TYPE=home:;;12 Elm St;;;;');
    expect(lines).toContain('URL;TYPE=homepage:https://sarah.example');
    expect(lines).toContain('BDAY:1990-06-03');
    expect(vcf.endsWith('END:VCARD\r\n')).toBe(true);
  });

  it('omits empty fields and a business contact has a name-only N', () => {
    const vcf = buildVCard({ name: "Joe's Plumbing", type: 'service', company: "Joe's Plumbing" });
    const lines = vcf.split('\r\n');
    expect(lines).toContain('N:;;;;');
    expect(lines).toContain("FN:Joe's Plumbing");
    expect(lines.some((l) => l.startsWith('TEL'))).toBe(false);
    expect(lines.some((l) => l.startsWith('BDAY'))).toBe(false);
  });

  it('escapes structural characters in values', () => {
    const vcf = buildVCard({ name: 'A; B, C\\D', phones: [{ label: 'main', value: '1,2;3' }] });
    expect(vcf).toContain('FN:A\\; B\\, C\\\\D');
    expect(vcf).toContain('TEL;TYPE=main:1\\,2\\;3');
  });
});
