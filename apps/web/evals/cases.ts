/**
 * Labelled cases for the evals. Hand-written, with the app's real skill
 * (examples/notes-app). Add a case whenever a real user phrase surprises us.
 *
 * `act` is the act a person would say they meant. `null` means "none of ours":
 * the right outcome is NOT to run anything (answer, ask, or say it cannot).
 */
export type PhraseCase = { phrase: string; act: string | null; note?: string };

export const PHRASES: PhraseCase[] = [
  // exact phrases the skill declares
  { phrase: 'new note buy milk', act: 'note.create' },
  { phrase: 'add a note call the dentist', act: 'note.create' },
  { phrase: 'write down the wifi password is on the fridge', act: 'note.create' },
  { phrase: 'remember to water the plants', act: 'note.create' },
  { phrase: 'search for invoices', act: 'note.search' },
  { phrase: 'find meeting notes', act: 'note.search' },
  { phrase: 'show notes about travel', act: 'note.search' },
  { phrase: 'tag this urgent', act: 'note.tag' },
  { phrase: 'label it work', act: 'note.tag' },
  { phrase: 'delete this note', act: 'note.delete' },
  { phrase: 'trash it', act: 'note.delete' },
  { phrase: 'go to settings', act: 'nav.open' },
  { phrase: 'open notes', act: 'nav.open' },
  { phrase: 'switch to dark', act: 'settings.theme' },
  { phrase: 'change theme to light', act: 'settings.theme' },
  { phrase: 'set font size 18', act: 'settings.fontSize' },
  { phrase: 'text size 20', act: 'settings.fontSize' },
  { phrase: 'change my email to a@b.co', act: 'settings.email' },
  // paraphrases the device is expected to cope with (typos, case, filler)
  { phrase: 'NEW NOTE pick up the kids', act: 'note.create', note: 'case' },
  { phrase: 'please add a note: send the report', act: 'note.create', note: 'filler' },
  { phrase: 'add note ring mum', act: 'note.create', note: 'shortened' },
  { phrase: 'serch for taxes', act: 'note.search', note: 'typo' },
  { phrase: 'could you find recipes', act: 'note.search', note: 'filler' },
  { phrase: 'go to the settings', act: 'nav.open', note: 'article' },
  { phrase: 'take me to settings', act: 'nav.open', note: 'paraphrase' },
  { phrase: 'dark mode', act: 'settings.theme', note: 'paraphrase' },
  { phrase: 'night mode please', act: 'settings.theme', note: 'paraphrase' },
  { phrase: 'make the text bigger', act: 'settings.fontSize', note: 'paraphrase, no number' },
  { phrase: 'update my email address', act: 'settings.email', note: 'paraphrase' },
  // things that are NOT acts of this app: the right result is to run nothing
  { phrase: 'what is the weather today', act: null },
  { phrase: 'tell me a joke', act: null },
  { phrase: 'order me a pizza', act: null },
  { phrase: 'export my notes to pdf', act: null, note: 'a knowledge question: answer, do not act' },
  { phrase: 'asdf qwerty', act: null },
  { phrase: 'transfer money to Sam', act: null },
  { phrase: 'delete my account', act: null, note: 'destructive and not declared' },
  { phrase: 'send an email to everyone', act: null },
];

/** What a careful person would do with each of the notes app's acts (the proposal). */
export const PROPOSAL: Record<string, 'L2' | 'L1' | 'off'> = {
  'note.create': 'L2',
  'note.search': 'L2',
  'note.tag': 'L1',
  'note.delete': 'L1',
  'nav.open': 'L1',
  'settings.theme': 'L1',
  'settings.fontSize': 'L2',
  'settings.email': 'off',
};
