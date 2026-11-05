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
      <h2>Sub-processors</h2><p>Vercel (hosting), Neon (database), Stripe (payments), Anthropic (language model for analysis and unclear phrases), GitHub (repository access).</p>
      <h2>Your users' phrases</h2><p>Most phrases are resolved on the user's device and never reach us. Phrases that do are used only to choose an act and are not used to train models.</p>
      <h2>Your rights</h2><p>Delete an app in the dashboard to delete its data; contact us to delete your account.</p>
    </Page>
  );
}
