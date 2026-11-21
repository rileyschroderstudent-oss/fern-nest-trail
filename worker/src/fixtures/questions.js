// Mock questions-stage output, shaped like QUESTIONS_SCHEMA (raw model output, no ids).
// Matches the SPEC.md 4.4 example brief: Vietnam, 4 travellers, 12 nights, July 2027.
export const QUESTIONS_FIXTURE = {
  status: 'ok',
  decline_reason: 'none',
  assumptions: [
    'Flying from Brisbane',
    'July is wet season in the north and south, and hot and mostly dry around Hoi An',
    'All four travellers are adults sharing twin rooms or a whole apartment',
  ],
  questions: [
    {
      text: 'Which route shape suits the group: north to south in one line, or two longer bases?',
      why: 'One line sees more but adds internal flights; two bases means less packing and more depth.',
      options: [
        'Hanoi to Ho Chi Minh City in one line',
        'Two bases: Hanoi and Hoi An',
        'Central and south only, skipping the north',
      ],
    },
    {
      text: 'July brings heavy afternoon rain in Hanoi and the south. How much does that matter?',
      why: 'It decides whether the plan leans on the drier central coast or keeps the north and south.',
      options: [
        'Fine with rain, keep the classic route',
        'Prefer to spend most nights on the drier central coast',
      ],
    },
    {
      text: 'For hiking, which matters more: limestone country near Ninh Binh or the mountains around Sapa?',
      why: 'Sapa needs an overnight train or a long drive each way; Ninh Binh is two hours from Hanoi.',
      options: [
        'Ninh Binh, easier to reach',
        'Sapa, worth the extra travel',
        'Skip a hiking base and do day walks only',
      ],
    },
    {
      text: 'How should the group handle food: street food and cheap eats, or a mix with a few sit-down meals and a cooking class?',
      why: 'It shifts the daily food budget and whether a paid food tour or class goes in the plan.',
      options: [
        'Mostly street food',
        'A mix, with one food tour',
        'A mix, with a food tour and a cooking class',
      ],
    },
  ],
};
