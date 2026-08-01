import * as express from "express";

import { Utils } from "../Utils";
import { Armory } from "../Armory";
import { DataTablesSsp } from "../DataTablesSsp";

export class IndexController {
    private armory: Armory;

    public constructor(armory: Armory) {
        this.armory = armory;
    }

    public async index(req: express.Request, res: express.Response): Promise<void> {
        res.render("index.hbs", {
            title: "Arla MMO Armory",
            realms: this.armory.config.realms.map((r) => r.name),
        });
    }

    public async search(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
        const realmName = req.query.realm as string;
        const realm = realmName === undefined ? this.armory.config.realms[0] : this.armory.config.realms.find((r) => r.name === realmName);
        if (realm === undefined) {
            return next(400);
        }

        const db = this.armory.getCharactersDb(realm.name);
        const charSet = await this.armory.getDatabaseCharset(realm.name);

        let ssp = new DataTablesSsp(req.query, db, "characters", "guid", [
            { name: "name", collation: `${charSet}_general_ci` },
            { name: "online", formatter: (online) => online === 1 },
            { name: "level" },
            { name: "class", formatter: (cls) => Utils.classNames[cls] },
            { name: "race", formatter: (race, row) => `${Utils.raceNames[race]}_${row[6] === 0 ? "male" : "female"}` },
            { table: "guild", name: "name" },
            { name: "money" },
            { name: "totaltime" },
            { name: "zone" },
            {
                name: "exploredZones",
                formatter: (exploredZones: string)=> exploredZones.trim()
                    .split(' ')
                    .map((n: string) => parseInt(n, 10))
                    .reduce((acc, n) => {
                        n = n - ((n >> 1) & 0x55555555);
                        n = (n & 0x33333333) + ((n >> 2) & 0x33333333);

                        const newZones = ((n + (n >> 4) & 0xF0F0F0F) * 0x1010101) >> 24;

                        return acc + newZones;
                    }, 0),
            },
            {
                name: 'quests',
                subquery: `
                    SELECT COUNT(quest)
                    FROM character_queststatus_rewarded
                    WHERE guid = characters.guid AND quest > 66000 AND quest <= 66018
                `,
                formatter: (quests) => String(quests),
            },
            { table: "account", name: "username" },
        ]);
        ssp.joins = [
            { table1: "characters", column1: "guid", table2: "guild_member", column2: "guid", kind: "LEFT" },
            { table1: "guild_member", column1: "guildid", table2: "guild", column2: "guildid", kind: "LEFT" },
        ];
        ssp.extraDataColumns = ["`characters`.`gender`"];

        if (this.armory.config.hideGameMasters) {
            ssp.joins.push({
                table1: "characters",
                column1: "account",
                table2: "account_access",
                column2: "id",
                database2: realm.authDatabase,
                kind: "LEFT",
                where: `AND \`account_access\`.\`RealmID\` IN (-1, ${realm.realmId}) AND \`account_access\`.\`gmlevel\` > 0`,
            });
            ssp = ssp.where("`account_access`.`id` IS NULL");
        }

        ssp.joins.push({
            table1: "characters",
            column1: "account",
            table2: "account",
            column2: "id",
            database2: realm.authDatabase,
            kind: "LEFT",
        });
        ssp = ssp.where("`account`.`username` NOT LIKE 'RNDBOT%' AND `account`.`username` != 'AHBOT'");

        const result = await ssp.where("`deleteInfos_Account` IS NULL").run(this.armory.config.dbQueryTimeout);

        res.json({
            ...result,
            realm: realm.name,
        });
    }
}
