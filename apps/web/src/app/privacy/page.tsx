import { Page } from '@/components/Page';

export const metadata = { title: 'Privacy' };

export default function Privacy() {
  return (
    <Page>
      <h1 style={{ marginTop: 24 }}>Privacy policy</h1>
      <p className="notice err">Draft for review by counsel before launch. Not yet in force.</p>
      <h2>What we collect</h2>
      <ul>
        <li>Your GitHub profile (id, login, name, email, avatar) when you sign in.</li>
        <li>Repository contents, only during an analysis or integration you start; source files are deleted when the job ends. The resulting skill and the location of each act are kept.</li>
        <li>For each app: the phrases sent to the intent API (not stored after the response), counts of intents and voice turns, model token usage and cost.</li>
        <li>Billing details are held by Stripe; we keep the customer and subscription ids.</li>
        <li>Anonymous page analytics (Vercel Web Analytics, no cookies).</li>
      </ul>
      <h2>Voice</h2>
      <ul>
        <li>Live voice is off until you turn it on, shows when the microphone is on, can be muted at any time, and turns itself off after three quiet minutes.</li>
        <li>Your audio goes from your browser straight to the voice provider (OpenAI Realtime) using a key that expires in two minutes. It does not pass through our servers and <strong>we do not record or store audio</strong>. We store only how many seconds were used, for the monthly limit.</li>
        <li>What you say is turned into text in your browser session and handled as a typed instruction: it is checked against your app's declared acts, and anything that changes something still asks for a yes.</li>
        <li>Your coding agent connects with a token you can revoke; it can only submit changes that wait for your approval. Projects started from empty or copied from a repository keep their files in our database until you delete the app; you can download them as a zip at any time.</li>
      </ul>
      <h2>Sub-processors</h2><p>Vercel (hosting and test sandboxes), Neon (database), Stripe (payments), Anthropic (language model for analysis and unclear phrases), OpenAI (realtime voice, when you turn live voice on), GitHub (repository access).</p>
      <h2>Your users' phrases</h2><p>Most phrases are resolved on the user's device and never reach us. Phrases that do are used only to choose an act and are not used to train models.</p>
      <h2>Your rights</h2><p>Delete an app in the dashboard to delete its data; contact us to delete your account.</p>
    </Page>
  );
}
