import { analyzeUpcoming } from "@/lib/engine-v4";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;
export async function GET(request:Request){
  const params=new URL(request.url).searchParams;
  const days=Math.max(1,Math.min(31,Number(params.get("days")||21)));
  const league=String(params.get("league")||"ALL");
  if(!/^(ALL|[A-Z0-9]{2,4})$/.test(league))
    return Response.json({error:"Lig kodu geçersiz."},{status:400});
  try{
    return Response.json(await analyzeUpcoming(days,league),{
      headers:{"Cache-Control":"no-store"}
    });
  }catch(error){
    return Response.json({error:error instanceof Error?error.message:"Model verisi alınamadı."},{status:500});
  }
}
