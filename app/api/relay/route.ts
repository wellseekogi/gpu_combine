import {getStore} from "@/db/store";
import {execute,getView,errorResponse,readBody} from "@/lib/relay/service.mjs";
import {RelayError} from "@/lib/relay/engine.mjs";
export const dynamic="force-dynamic";
function user(req:Request){const id=req.headers.get("oai-authenticated-user-id");if(!id)throw new RelayError("로그인이 필요합니다.",401);return id;}
export async function GET(req:Request){try{return Response.json(await getView(getStore(),user(req)),{headers:{"Cache-Control":"no-store"}});}catch(e){return errorResponse(e);}}
export async function POST(req:Request){try{const origin=req.headers.get("origin");if(origin&&origin!==new URL(req.url).origin)throw new RelayError("다른 출처의 요청입니다.",403);const id=user(req);return Response.json(await execute(getStore(),id,await readBody(req)),{headers:{"Cache-Control":"no-store"}});}catch(e){return errorResponse(e);}}
