import { seasonCoverage } from "@/lib/season-2026";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;
export async function GET(){
 try{return Response.json(await seasonCoverage(),{headers:{"Cache-Control":"no-store"}});}
 catch(e){return Response.json({error:e instanceof Error?e.message:"Veri kapsamı okunamadı"},{status:500});}
}
