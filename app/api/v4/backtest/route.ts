import { backtestEngine } from "@/lib/engine-v4";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;
export async function GET(request:Request){
  const code=new URL(request.url).searchParams.get("league")||"ALL";
  if(!/^(ALL|[A-Z0-9]{2,4})$/.test(code))
    return Response.json({error:"Geçersiz lig kodu"},{status:400});
  try{
    return Response.json(await backtestEngine(code),{
      headers:{"Cache-Control":"no-store"}
    });
  }catch(error){
    return Response.json({error:error instanceof Error?error.message:"Backtest çalıştırılamadı"},{status:500});
  }
}
