/**
 * Colour tokens. Light: cool light blue with navy actions. Dark: true
 * charcoal with light-blue accents. Both have a dark charcoal header.
 * The calm palette lowers saturation for the low-stimulation mode.
 * Feedback never relies on colour alone: it always has text.
 */
export interface Palette {
  background: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
  primary: string;
  onPrimary: string;
  header: string;
  onHeader: string;
  feedbackRight: string;
  feedbackNotYet: string;
}

export const palettes = {
  // The same values as the ASafariM OS theme (asafarim-os packages/theme/theme.css).
  light: {
    background: "#D8E6F1",
    surface: "#FFFFFF",
    text: "#15212B",
    muted: "#4B5B69",
    border: "#B9CFDF",
    primary: "#0F4C6E",
    onPrimary: "#FFFFFF",
    header: "#222222",
    onHeader: "#F4F4F4",
    feedbackRight: "#DCEBFA",
    feedbackNotYet: "#EEF4F9",
  },
  dark: {
    background: "#262626",
    surface: "#1C1C1C",
    text: "#F2F2F2",
    muted: "#B5B5B5",
    border: "#3D3D3D",
    primary: "#7FB0DC",
    onPrimary: "#0D1B26",
    header: "#161616",
    onHeader: "#F2F2F2",
    feedbackRight: "#1E3550",
    feedbackNotYet: "#303030",
  },
  calmLight: {
    background: "#F1F4F7",
    surface: "#FFFFFF",
    text: "#1E2733",
    muted: "#55606D",
    border: "#D5DCE4",
    primary: "#3D5675",
    onPrimary: "#FFFFFF",
    header: "#2A2E33",
    onHeader: "#E6EBF0",
    feedbackRight: "#E3EAF2",
    feedbackNotYet: "#ECEEF1",
  },
  calmDark: {
    background: "#181A1D",
    surface: "#1F2226",
    text: "#D9E0E7",
    muted: "#9AA5B1",
    border: "#2C3137",
    primary: "#9DB7D1",
    onPrimary: "#14191F",
    header: "#121417",
    onHeader: "#D9E0E7",
    feedbackRight: "#25303C",
    feedbackNotYet: "#262A2F",
  },
} satisfies Record<string, Palette>;

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 } as const;
export const radius = { md: 12, lg: 16 } as const;
export const fontSize = { body: 18, small: 15, title: 24, big: 30 } as const;
