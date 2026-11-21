// Mock declined outputs for destination TEST-DECLINE: status declined, reason not_travel,
// every other field empty, as the system prompt asks.
export const DECLINED_QUESTIONS_FIXTURE = {
  status: 'declined',
  decline_reason: 'not_travel',
  assumptions: [],
  questions: [],
};

export const DECLINED_PLAN_FIXTURE = {
  status: 'declined',
  decline_reason: 'not_travel',
  title: '',
  route: [],
  season_note: '',
  flights: { routing: '', timing: '', peak_warning: '' },
  days: [],
  budget_items: [],
  levers: [],
  honest_take: '',
  verify_before_booking: [],
  assumptions: [],
};
