import {sqliteTable,text,integer} from "drizzle-orm/sqlite-core";
export const pools=sqliteTable("relay_pools",{id:text("id").primaryKey(),revision:integer("revision").notNull().default(0),state:text("state").notNull()});
