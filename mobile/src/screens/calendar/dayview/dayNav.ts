import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { CalendarStackParamList } from '../../../navigation/CalendarNavigator';
import { AllDayItem } from './dayViewLayout';
import { occasionFocusFrom } from '../../../lib/occasions';

export type DayNav = NativeStackNavigationProp<CalendarStackParamList, 'CalendarDay'>;

// Where tapping a day-view item leads — the same routing the old day screen's
// rows used. Occasions open the Occasions calendar; holidays have no detail
// screen; grocery and a recipe without a linked record land on the kitchen.
export function openAllDayItem(navigation: DayNav, item: AllDayItem, date: string) {
  switch (item.kind) {
    case 'event':
      if (item.id) navigation.navigate('EventDetail', { eventId: item.id, date });
      break;
    case 'occasion':
      navigation.navigate('Birthdays', item.occasion ? { focus: occasionFocusFrom(item.occasion) } : undefined);
      break;
    case 'trip':
      if (item.id) navigation.navigate('TripDetail', { id: item.id });
      break;
    // Tasks and chores repeat, so they carry the tapped day through the same
    // way events do — it's what scopes an edit or delete to this occurrence.
    case 'task':
      if (item.id) navigation.navigate('TaskDetail', { id: item.id, date });
      break;
    case 'chore':
      if (item.id) navigation.navigate('ChoreDetail', { id: item.id, date });
      break;
    case 'recipe':
      if (item.id) navigation.navigate('RecipeDetail', { id: item.id });
      else navigation.navigate('KitchenHome');
      break;
    case 'grocery':
      // Shopping list for this day's period, with the day queued for the
      // Planner pane (see KitchenHome's params in navigation/types.ts).
      navigation.navigate('KitchenHome', { pane: 'grocery', weekStart: date, scrollToDate: date });
      break;
    default:
      break;
  }
}
