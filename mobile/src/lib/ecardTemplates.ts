import type { OccasionKind } from '../api';

// E-card style gallery — MIRRORS server/src/services/ecardTemplates.js GALLERY
// (the server owns the email rendering; this file drives the in-form picker +
// live preview). Keys are the stable `template` strings persisted on the ECard
// row; a server test greps this file to keep the two lists in sync.

export interface ECardDeco {
  type: 'confetti' | 'float' | 'twinkle' | 'drift';
  /** Emoji pieces for float/twinkle/drift rows. */
  pieces?: string[];
  /** Confetti piece colours. */
  colors?: string[];
}

export interface ECardTemplateMeta {
  key: string;
  /** Picker label. */
  name: string;
  heading: string;
  emoji: string;
  /** Page canvas behind the card. */
  wash: string;
  /** Cover gradient start/end. */
  g1: string;
  g2: string;
  /** Heading colour on the cover. */
  heroText: string;
  /** Display-serif heading (Georgia) instead of the system sans. */
  serif: boolean;
  /** The card's closing phrase, above the sender's name. */
  signoff: string;
  deco: ECardDeco;
}

export const ECARD_GALLERY: Record<OccasionKind, ECardTemplateMeta[]> = {
  birthday: [
    { key: 'birthday-confetti', name: 'Confetti', heading: 'Happy Birthday!', emoji: '🎂',
      wash: '#FFF3EC', g1: '#FF6B6B', g2: '#FFA94D', heroText: '#FFFFFF', serif: false,
      signoff: 'With love,',
      deco: { type: 'confetti', colors: ['#FFD166', '#FFFFFF', '#5AD2F4', '#C3F584', '#FF9BD2'] } },
    { key: 'birthday-balloons', name: 'Balloons', heading: 'Happy Birthday!', emoji: '🥳',
      wash: '#EFF8FF', g1: '#4FACFE', g2: '#00D2FE', heroText: '#FFFFFF', serif: false,
      signoff: 'Cheers,',
      deco: { type: 'float', pieces: ['🎈', '🎈', '🎈', '🎈', '🎈'] } },
    { key: 'birthday-gold', name: 'Golden', heading: 'Happy Birthday', emoji: '🎂',
      wash: '#F7F3EA', g1: '#2C3345', g2: '#151A26', heroText: '#F5D482', serif: true,
      signoff: 'Warm wishes,',
      deco: { type: 'twinkle', pieces: ['✨', '✦', '✨', '✦', '✨'] } },
  ],
  anniversary: [
    { key: 'anniversary-hearts', name: 'Hearts', heading: 'Happy Anniversary!', emoji: '💞',
      wash: '#FFF0F3', g1: '#FF9A9E', g2: '#FAD0C4', heroText: '#FFFFFF', serif: true,
      signoff: 'With love,',
      deco: { type: 'float', pieces: ['❤️', '💕', '❤️', '💕', '❤️'] } },
    { key: 'anniversary-gold', name: 'Golden Years', heading: 'Happy Anniversary', emoji: '💍',
      wash: '#FBF6EA', g1: '#F3E3BC', g2: '#E3C878', heroText: '#6F5417', serif: true,
      signoff: 'Warmly,',
      deco: { type: 'twinkle', pieces: ['✨', '✦', '✨', '✦', '✨'] } },
    { key: 'anniversary-bloom', name: 'In Bloom', heading: 'Happy Anniversary!', emoji: '🌹',
      wash: '#F6F1FB', g1: '#FBC2EB', g2: '#A6C1EE', heroText: '#FFFFFF', serif: true,
      signoff: 'With love,',
      deco: { type: 'drift', pieces: ['🌸', '💮', '🌷', '💮', '🌸'] } },
  ],
  marriage: [
    { key: 'marriage-bouquet', name: 'Bouquet', heading: 'Congratulations!', emoji: '💐',
      wash: '#FCF7F0', g1: '#FDF3E7', g2: '#F5DFC8', heroText: '#8A5A2B', serif: true,
      signoff: 'All our best,',
      deco: { type: 'drift', pieces: ['🌿', '🌸', '🤍', '🌸', '🌿'] } },
    { key: 'marriage-champagne', name: 'Champagne', heading: 'Cheers to You Both!', emoji: '🥂',
      wash: '#FFF6E9', g1: '#F6D365', g2: '#FDA085', heroText: '#FFFFFF', serif: false,
      signoff: 'With joy,',
      deco: { type: 'twinkle', pieces: ['✨', '🫧', '✨', '🫧', '✨'] } },
    { key: 'marriage-celebration', name: 'Celebration', heading: 'Congratulations!', emoji: '🎊',
      wash: '#F5F1FC', g1: '#A18CD1', g2: '#FBC2EB', heroText: '#FFFFFF', serif: false,
      signoff: 'Cheers,',
      deco: { type: 'confetti', colors: ['#FFD166', '#FFFFFF', '#8BE8CB', '#FF9BD2', '#B3C7FF'] } },
  ],
  death: [
    { key: 'condolence-dove', name: 'Dove', heading: 'Thinking of You', emoji: '🕊️',
      wash: '#F2F6FB', g1: '#E0EAFC', g2: '#CFDEF3', heroText: '#3D4E63', serif: true,
      signoff: 'With sympathy,',
      deco: { type: 'drift', pieces: ['☁️', '🕊️', '☁️'] } },
    { key: 'condolence-candle', name: 'Candlelight', heading: 'In Loving Memory', emoji: '🕯️',
      wash: '#F4F1F5', g1: '#E6E1E8', g2: '#CFC7D4', heroText: '#4A3F52', serif: true,
      signoff: 'With deepest sympathy,',
      deco: { type: 'twinkle', pieces: ['✦', '·', '✦', '·', '✦'] } },
    { key: 'condolence-sky', name: 'Evening Sky', heading: 'Forever in Our Hearts', emoji: '🌌',
      wash: '#F0F2F8', g1: '#3E4C6D', g2: '#69739B', heroText: '#EDEFF7', serif: true,
      signoff: 'Thinking of you,',
      deco: { type: 'twinkle', pieces: ['✦', '⭐', '✦', '⭐', '✦'] } },
  ],
  custom: [
    { key: 'custom-classic', name: 'Classic', heading: 'A Note for You', emoji: '✨',
      wash: '#EFF6FF', g1: '#4F9DF5', g2: '#7CC0FF', heroText: '#FFFFFF', serif: false,
      signoff: 'Warm wishes,',
      deco: { type: 'twinkle', pieces: ['✨', '✦', '✨', '✦', '✨'] } },
    { key: 'custom-sunshine', name: 'Sunshine', heading: 'A Note for You', emoji: '🌻',
      wash: '#FFFAEC', g1: '#FCE38A', g2: '#F5AF6E', heroText: '#7A4A12', serif: false,
      signoff: 'Warmly,',
      deco: { type: 'float', pieces: ['🌞', '🌼', '🌻', '🌼', '🌞'] } },
    { key: 'custom-midnight', name: 'Starry Night', heading: 'A Note for You', emoji: '🌙',
      wash: '#EEF0F6', g1: '#1E2A4A', g2: '#3A4B7C', heroText: '#F5D482', serif: true,
      signoff: 'Best wishes,',
      deco: { type: 'twinkle', pieces: ['⭐', '✨', '⭐', '✨', '⭐'] } },
  ],
};

// The variant a card renders with: the stored key when it exists, else the
// kind's first (default) style — mirrors the server's resolveTemplate, so a
// legacy row (which stored `template: <kind>`) previews as its default.
export function resolveTemplate(kind: OccasionKind, key?: string): ECardTemplateMeta {
  const list = ECARD_GALLERY[kind] ?? ECARD_GALLERY.custom;
  return list.find((v) => v.key === key) ?? list[0];
}
