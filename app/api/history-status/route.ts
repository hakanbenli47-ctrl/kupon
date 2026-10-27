import { historyCoverage } from "@/lib/history-sync";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(){
  return Response.json(await historyCoverage(),{headers:{"Cache-Control":"no-store"}});
}
