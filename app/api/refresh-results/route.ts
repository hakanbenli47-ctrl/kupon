import { runRecentResultSync } from "@/lib/cloud-sync";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;

// Public manual refresh is rate-limited across all visitors in the database.
// Only verified fixture statuses may be written by provider adapters.
export async function POST() {
  try {
    return Response.json(await runRecentResultSync({maxFixtures:25}),{
      headers:{"Cache-Control":"no-store"}
    });
  } catch(error) {
    return Response.json({
      ok:false,error:error instanceof Error?error.message:"Maç sonuçları güncellenemedi."
    },{status:500});
  }
}
