import { redirect } from 'next/navigation';
export default async function AppIndex({ params }: { params: Promise<{ id: string }> }) {
  redirect(`/dashboard/apps/${(await params).id}/map`);
}
