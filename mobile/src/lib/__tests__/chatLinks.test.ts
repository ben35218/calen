import { Linking, Platform } from 'react-native';
import { parseChatLinks, placeUrl, searchUrl, openPlaceInGoogleMaps } from '../chatLinks';

// Assistant replies carry [text](place:query) / [text](search:query) markers
// (see server WEB_SEARCH_SYSTEM_NOTE); the parser splits them into pressable
// segments and flattens everything else to plain text.

describe('parseChatLinks', () => {
  it('returns one plain segment for a reply with no links', () => {
    expect(parseChatLinks('Just a **plain** answer.')).toEqual([
      { kind: 'text', text: 'Just a plain answer.' },
    ]);
  });

  it('splits place links out of surrounding text', () => {
    const segs = parseChatLinks(
      'Try [Little Ray’s Nature Centre](place:Little Ray’s Nature Centre, Ottawa) — kids love it.',
    );
    expect(segs).toEqual([
      { kind: 'text', text: 'Try ' },
      { kind: 'place', text: 'Little Ray’s Nature Centre', query: 'Little Ray’s Nature Centre, Ottawa' },
      { kind: 'text', text: ' — kids love it.' },
    ]);
  });

  it('parses search links and keeps multiple links in order', () => {
    const segs = parseChatLinks(
      'Visit [Saunders Farm](place:Saunders Farm, Munster) or [search "petting zoos near Orleans"](search:petting zoos near Orleans, Ottawa).',
    );
    expect(segs.map((s) => s.kind)).toEqual(['text', 'place', 'text', 'search', 'text']);
    expect(segs[3]).toEqual({
      kind: 'search',
      text: 'search "petting zoos near Orleans"',
      query: 'petting zoos near Orleans, Ottawa',
    });
  });

  it('flattens markdown inside link text and plain segments alike', () => {
    const segs = parseChatLinks('- **Top pick:** [**Saunders Farm**](place:Saunders Farm)');
    expect(segs).toEqual([
      { kind: 'text', text: '• Top pick: ' },
      { kind: 'place', text: 'Saunders Farm', query: 'Saunders Farm' },
    ]);
  });

  it('leaves ordinary markdown links as plain text (only place/search are tappable)', () => {
    expect(parseChatLinks('See [their site](https://example.com) for hours.')).toEqual([
      { kind: 'text', text: 'See their site for hours.' },
    ]);
  });

  it('trimIncomplete hides a half-streamed trailing link marker', () => {
    expect(parseChatLinks('Try [Saunders Fa', { trimIncomplete: true })).toEqual([
      { kind: 'text', text: 'Try ' },
    ]);
    expect(parseChatLinks('Try [Saunders Farm](place:Saun', { trimIncomplete: true })).toEqual([
      { kind: 'text', text: 'Try ' },
    ]);
    // A completed link at the end survives.
    expect(parseChatLinks('Try [Saunders Farm](place:Saunders Farm)', { trimIncomplete: true })).toEqual([
      { kind: 'text', text: 'Try ' },
      { kind: 'place', text: 'Saunders Farm', query: 'Saunders Farm' },
    ]);
  });

  it('drops a link with an empty query or display text instead of rendering junk', () => {
    expect(parseChatLinks('[Saunders Farm](place: )')).toEqual([]);
  });
});

describe('URL builders', () => {
  it('placeUrl targets the Google Maps place lookup', () => {
    expect(placeUrl(' Saunders Farm, Munster ')).toBe(
      'https://www.google.com/maps/search/?api=1&query=Saunders%20Farm%2C%20Munster',
    );
  });
  it('searchUrl targets a plain Google search', () => {
    expect(searchUrl('petting zoos near Orleans, Ottawa')).toBe(
      'https://www.google.com/search?q=petting%20zoos%20near%20Orleans%2C%20Ottawa',
    );
  });
});

// A tapped place link prefers the native Google Maps app; the caller only opens
// the in-app WebView preview when this reports the app couldn't take the link.
describe('openPlaceInGoogleMaps', () => {
  // Linking.* is already a jest mock under jest-expo, so clear call history
  // between cases (restoreAllMocks alone leaves the shared fn's calls behind).
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.restoreAllMocks());

  it('hands the place to the Google Maps app on iOS when it is installed', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    const can = jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(true);
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as never);
    await expect(openPlaceInGoogleMaps(' Saunders Farm, Munster ')).resolves.toBe(true);
    expect(can).toHaveBeenCalledWith('comgooglemaps://?q=Saunders%20Farm%2C%20Munster');
    expect(open).toHaveBeenCalledWith('comgooglemaps://?q=Saunders%20Farm%2C%20Munster');
  });

  it('reports false (caller falls back to the WebView) when Maps is not installed', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(false);
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as never);
    await expect(openPlaceInGoogleMaps('Saunders Farm')).resolves.toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it('treats a canOpenURL rejection as not installed', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    jest.spyOn(Linking, 'canOpenURL').mockRejectedValue(new Error('nope'));
    await expect(openPlaceInGoogleMaps('Saunders Farm')).resolves.toBe(false);
  });

  it('uses the geo: intent on Android', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(true);
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as never);
    await expect(openPlaceInGoogleMaps('Saunders Farm')).resolves.toBe(true);
    expect(open).toHaveBeenCalledWith('geo:0,0?q=Saunders%20Farm');
  });
});
