import {getStore} from "@/db/store";
import {execute,errorResponse,readBody} from "@/lib/relay/service.mjs";
import {RelayError} from "@/lib/relay/engine.mjs";
export const dynamic="force-dynamic";
export async function POST(req:Request){try{const body=await readBody(req);const token=req.headers.get("authorization")?.replace(/^Bearer /,"");if(!token||typeof body.poolId!=="string"||body.poolId.length>200)throw new RelayError("제공자 인증이 필요합니다.",401);return Response.json(await execute(getStore(),body.poolId,{...body,mode:"live",token},{provider:true}),{headers:{"Cache-Control":"no-store"}});}catch(e){return errorResponse(e);}}
