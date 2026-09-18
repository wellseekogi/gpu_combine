import {env} from "cloudflare:workers";
export function getStore(){const db=env.DB;if(!db)throw new Error("DB unavailable");
return {read:(id:string)=>db.prepare("SELECT revision,state FROM relay_pools WHERE id=?").bind(id).first<{revision:number,state:string}>(),
insert:(id:string,state:string)=>db.prepare("INSERT OR IGNORE INTO relay_pools(id,revision,state) VALUES (?,0,?)").bind(id,state).run(),
compareAndSwap:async(id:string,revision:number,state:string)=>{const result=await db.prepare("UPDATE relay_pools SET state=?,revision=revision+1 WHERE id=? AND revision=?").bind(state,id,revision).run();return result.meta.changes===1;}};}
