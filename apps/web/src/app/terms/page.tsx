import { Page } from '@/components/Page';

export const metadata = { title: 'Terms' };

export default function Terms() {
  return (
    <Page>
      <h1 style={{ marginTop: 24 }}>Terms of service</h1>
      <p className="notice err">Draft for review by counsel before launch. Not yet in force.</p>
      <h2>1. The service</h2><p>Entoli analyzes repositories you connect, produces skill files, and provides an SDK and an API that let your users operate your app by intent.</p>
      <h2>2. Your account and your code</h2><p>You keep all rights to your code and data. You grant Entoli the access needed to analyze the repositories you connect and, when you ask for it, to open pull requests you approved.</p>
      <h2>3. Your users</h2><p>You are responsible for the acts you declare, their radius and undo, and for complying with laws that apply to your app. Entoli runs the commit contract as documented.</p>
      <h2>4. Plans, usage and payment</h2><p>Plans are billed monthly per app through Stripe; usage beyond the plan is billed as published on the pricing page. You can cancel at any time from the billing portal; the plan ends at the end of the paid period.</p>
      <h2>5. Acceptable use</h2><p>No use to harm others, to break laws, or to overload the service. Keys may be rate-limited or revoked for abuse.</p>
      <h2>6. Availability and liability</h2><p>The service is provided as is during the developer preview. Liability is limited to the amounts paid in the previous twelve months, to the extent the law allows.</p>
      <h2>7. Changes</h2><p>We will notify you of material changes at least 30 days in advance.</p>
    </Page>
  );
}
