// Builds the single user message for each stage (SPEC.md 4.9). The system prompt
// never contains user text; everything the visitor typed, and everything from an
// earlier step, goes in here inside data tags.

const STAGE_LABEL = { start: 'questions', plan: 'plan', revise: 'revise' };

const LAST_LINE = {
  start: 'Write the interview questions.',
  plan: 'Write the trip plan.',
  revise: 'Rewrite the whole plan with the change applied.',
};

// Compact JSON with < and > escaped as \u003c and \u003e. The value is unchanged
// for any JSON reader, but text such as "</current_plan>" inside a string can never
// close a data tag early.
function jsonBlock(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

const block = (tag, body) => [`<${tag}>`, body, `</${tag}>`];

// The interview as [{ question, answer }], with the text looked up from the token's
// questions by id, in question order.
export function interviewOf(questions, answers) {
  const chosen = new Map(answers.map((a) => [a.questionId, a.optionId]));
  return questions.map((q) => {
    const option = q.options.find((o) => o.id === chosen.get(q.id));
    if (!option) throw new Error('answer does not match the questions');
    return { question: q.text, answer: option.label };
  });
}

// buildMessage(stage, state, today)
//   stage  'start' | 'plan' | 'revise'
//   state  { brief, questions, answers, plan, request }; plan stage needs questions
//          and answers, revise also needs plan and request
//   today  a Date; only its UTC date is used
export function buildMessage(stage, state, today) {
  if (!Object.hasOwn(STAGE_LABEL, stage)) throw new Error(`unknown stage ${stage}`);
  const lines = [
    `Today is ${today.toISOString().slice(0, 10)} (UTC).`,
    `STAGE: ${STAGE_LABEL[stage]}`,
    ...block('trip_brief', jsonBlock(state.brief)),
  ];
  if (stage === 'plan' || stage === 'revise') {
    lines.push(...block('interview', jsonBlock(interviewOf(state.questions, state.answers))));
  }
  if (stage === 'revise') {
    lines.push(...block('current_plan', jsonBlock(state.plan)));
    lines.push(...block('change_request', state.request));
  }
  lines.push(LAST_LINE[stage]);
  return lines.join('\n');
}
