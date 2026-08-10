// Imperative handle shared by every calendar view layer (month grid, list) so
// the host's single "Today" button can drive whichever layer is active.
export type TodayHandle = {
  scrollToToday: (animated?: boolean) => void;
  // The day the layer considers "selected", if it has that concept (the List
  // layer's tapped day). The host's add button seeds a new event with it.
  getSelectedDate?: () => string | null;
};
