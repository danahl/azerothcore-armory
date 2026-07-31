import * as express from "express";
import { RowDataPacket } from "mysql2/promise";

import { Armory } from "../Armory";
import { IRealmConfig } from "../Config";
import { IEmblem, Utils } from "../Utils";
import { IAchievement as IAchievementDbc, ISkillDbc, IAreas} from "../data/DbcReader";

interface ICharacterData {
    guid: number;
    name: string;
    race: number;
    class: number;
    gender: number;
    level: number;
    skin: number;
    face: number;
    hairStyle: number;
    hairColor: number;
    facialStyle: number;
    playerFlags: number;
    online: number;
    guild: string;
    map: number;
    zone: number;
    zoneName: string;
    position_x: number;
    position_y: number;
}

interface IEquipmentData {
    slot: number;
    itemEntry: number;
    flags: number;
    enchantments: string | number[];
    randomPropertyId: number;
    classId: number;
    subclassId: number;
    quality: number;
    transmog?: number;
    icon?: number;
    gems?: number[];
}

interface IMount {
    creatureDisplayId: number;
    spell: number;
    icon: string;
}

interface IAchievement {
    id: number;
    category: number;
    title: string;
    description: string;
    points: number;
    icon: string;
}

interface IArenaTeam {
    id: number;
    name: string;
    type: number;
    rating: number;
    seasonWins: number;
    seasonGames: number;
    background: number;
    emblemStyle: number;
    emblemColor: number;
    borderStyle: number;
    borderColor: number;
    emblem?: IEmblem;
}

interface ISkills {
    id: number;
    categoryId: number
    skill: string;
    value: number;
    max: number ;
}

interface IReputation {
    id: number;
    name: string;
    standing: string;
    value: number;
    valueInGrade: number;
    max: number;
    expansionId: number;
}

interface IQuest {
    id: number;
    title: string;
    status: 'Completed' | 'In Progress';
    minLevel: number;
    questLevel: number;
    questSortID: number;
}

const ItemClassGem = 3;
const SpellMechanicMounted = 21;
const RaceDisplayName = {
    1: "Human",
    2: "Orc",
    3: "Dwarf",
    4: "Night Elf",
    5: "Undead",
    6: "Tauren",
    7: "Gnome",
    8: "Troll",
    10: "Blood Elf",
    11: "Draenei",
};
const ClassDisplayName = {
    1: "Warrior",
    2: "Paladin",
    3: "Hunter",
    4: "Rogue",
    5: "Priest",
    6: "Death Knight",
    7: "Shaman",
    8: "Mage",
    9: "Warlock",
    11: "Druid",
};

export class CharacterController {
    private armory: Armory;
    private areaById: { [key: number]: IAreas };
    private itemInventoryTypes: { [key: number]: number };
    private itemIcons: { [key: number]: number };
    private gemItems: { [key: number]: boolean };
    private enchantSrcItems: { [key: number]: number };
    private itemSocketBonuses: { [key: number]: number };
    private mountSpells: number[];
    private mountBySpellId: { [key: number]: IMount };
    private skillById: { [key: number]: ISkillDbc };
    private achievementById: { [key: number]: IAchievementDbc };

    public constructor(armory: Armory) {
        this.armory = armory;
    }

    public async load(): Promise<void> {
        this.itemInventoryTypes = {};
        const itemsRetail = await this.armory.dbc.itemRetail().toArray();
        for await (const item of this.armory.dbc.item()) {
            const retailItem = itemsRetail.find((row) => row.id === item.id);
            if (retailItem !== undefined) {
                this.itemInventoryTypes[item.id] = retailItem.inventoryType;
            }
        }

        this.itemIcons = {};
        const itemIconsByDisplayInfoId: { [key: number]: number } = {};
        for await (const row of this.armory.dbc.itemDisplayInfo()) {
            itemIconsByDisplayInfoId[row.id] = row.inventoryIcon0;
        }
        for await (const item of this.armory.dbc.item()) {
            const icon = itemIconsByDisplayInfoId[item.displayInfoId];
            if (icon !== undefined) {
                this.itemIcons[item.id] = icon;
            }
        }

        this.gemItems = {};
        for await (const row of this.armory.dbc.item().filter((item) => item.classId === ItemClassGem)) {
            this.gemItems[row.id] = true;
        }

        this.enchantSrcItems = {};
        for await (const row of this.armory.dbc.spellItemEnchantment()) {
            this.enchantSrcItems[row.id] = row.srcItemId;
        }

        this.itemSocketBonuses = {};
        const [rows] = await this.armory.worldDb.query({
            sql: "SELECT entry, socketBonus FROM item_template WHERE socketBonus <> 0",
            timeout: this.armory.config.dbQueryTimeout,
        });
        for (const row of rows as RowDataPacket[]) {
            this.itemSocketBonuses[row.entry] = row.socketBonus;
        }

        const mountSpells = await this.armory.dbc
            .spell()
            .filter((m) => m.mechanic === SpellMechanicMounted)
            .toArray();
        this.mountSpells = mountSpells.map((spell) => spell.id);
        this.mountBySpellId = {};
        for (const spell of mountSpells) {
            const mount = await this.armory.dbc.mount().find((m) => m.sourceSpellId === spell.id);
            const icon = await this.armory.dbc.spellIcon().find((icon) => icon.id === spell.spellIconId);
            if (mount !== undefined) {
                const display = await this.armory.dbc.mountDisplay().find((d) => d.mountId === mount.id);
                if (display !== undefined) {
                    this.mountBySpellId[spell.id] = {
                        creatureDisplayId: display.creatureDisplayInfoId,
                        spell: spell.id,
                        icon: this.processSpellIconTexture(icon?.textureFilename ?? ""),
                    };
                }
            }
        }

        this.achievementById = {};
        for await (const achievement of this.armory.dbc.achievement()) {
            this.achievementById[achievement.id] = achievement;
        }

        this.skillById = {};
        for await (const skill of this.armory.dbc.skill()) {
            this.skillById[skill.id] = skill;
        }
        this.areaById = {};
        for await (const area of this.armory.dbc.areas()) {
            this.areaById[area.id] = area;
        }
    }

    public async character(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
        const realmName = req.params.realm;
        const charName = req.params.name;

        const realm = this.armory.getRealm(realmName);
        if (realm === undefined) {
            // Could not find realm
            return next(404);
        }

        const charData = await this.getCharacterData(realm, charName);
        if (charData === null) {
            // Could not find character
            return next(404);
        }

        const equipmentData = await this.getEquipmentData(realmName, charData.guid);
        const equipment = equipmentData.map((row) => {
            row.icon = this.itemIcons[row.itemEntry];
            row.gems = this.getGemsFromEnchantments(row.enchantments as string);
            row.enchantments = this.filterEnchantments(row.itemEntry, row.enchantments as string);

            return row;
        });
        const mounts = await this.getMounts(realmName, charData.guid);

        res.render("character.hbs", {
            title: `Arla MMO Armory - ${charData.name}`,
            ...this.makeSharedDataObject(realm, charData),
            data: {
                race: charData.race,
                gender: charData.gender,
                class: charData.class,
                flags: charData.playerFlags,
                equipment,
                mounts,
            },
        });

        this.armory.gc();
    }

    public async talents(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
        const realmName = req.params.realm;
        const charName = req.params.name;

        const realm = this.armory.getRealm(realmName);
        if (realm === undefined) {
            // Could not find realm
            return next(404);
        }

        const charData = await this.getCharacterData(realm, charName);
        if (charData === null) {
            // Could not find character
            return next(404);
        }

        res.render("character-talents.hbs", {
            title: `Arla MMO Armory - ${charData.name} - Talents`,
            ...this.makeSharedDataObject(realm, charData),
            data: {
                talents: await this.getTalents(realm.name, charData.guid),
                trees: await this.getTalentTrees(charData.class),
                glyphs: await this.getGlyphs(realm.name, charData.guid),
            },
        });
    }

    public async skills(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
        const realmName = req.params.realm;
        const charName = req.params.name;

        const realm = this.armory.getRealm(realmName);
        if (realm === undefined) {
            // Could not find realm
            return next(404);
        }

        const charData = await this.getCharacterData(realm, charName);
        if (charData === null) {
            // Could not find character
            return next(404);
        }
        const skills = await this.getSkills(realm.name, charData.guid);
        const professions = skills.filter((skill) => skill.categoryId === 11);
        const secondarySkills = skills.filter((skill) => skill.categoryId === 9);
        const weaponSkills = skills.filter((skill) => skill.categoryId === 6);
        const classSkills = skills.filter((skill) => skill.categoryId === 7);
        const armorSkills = skills.filter((skill) => skill.categoryId === 8);
        const languages = skills.filter((skill) => skill.categoryId === 10);
        res.render("character-skills.hbs", {
            title: `Armory - ${charData.name} - Skills`,
            ...this.makeSharedDataObject(realm, charData),
            data: {
                skills: skills,
                professions: professions,
                secondarySkills: secondarySkills,
                weaponSkills: weaponSkills,
                classSkills: classSkills,
                armorSkills: armorSkills,
                languages: languages,
            },
        });
    }

    public async reputation(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
        const realmName = req.params.realm;
        const charName = req.params.name;

        const realm = this.armory.getRealm(realmName);
        if (realm === undefined) {
            return next(404);
        }

        const charData = await this.getCharacterData(realm, charName);
        if (charData === null) {
            return next(404);
        }

        const reputations = await this.getReputations(realm.name, charData.guid);
        // Group reputations by expansion/category
        const classicReps = reputations.filter(rep => rep.expansionId === 0);
        const tbcReps = reputations.filter(rep => rep.expansionId === 1);
        const wotlkReps = reputations.filter(rep => rep.expansionId === 2);

        res.render("character-reputation.hbs", {
            title: `Armory - ${charData.name} - Reputation`,
            ...this.makeSharedDataObject(realm, charData),
            data: {
                classic: classicReps,
                tbc: tbcReps,
                wotlk: wotlkReps
            },
        });
    }

    public async quests(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
        const realmName = req.params.realm;
        const charName = req.params.name;

        const realm = this.armory.getRealm(realmName);
        if (realm === undefined) {
            return next(404);
        }

        const charData = await this.getCharacterData(realm, charName);
        if (charData === null) {
            return next(404);
        }

        const quests = await this.getQuests(realm.name, charData.guid);

        // Group quests by zone/profession
        const questsByCategory = quests.reduce((acc, quest) => {
            const category = quest.questSortID > 0 ?
                this.getZoneName(quest.questSortID):
                this.getProfessionName(quest.questSortID);

            if (!acc[category]) {
                acc[category] = [];
            }
            acc[category].push(quest);
            return acc;
        }, {});

        // Get list of all characters
        const allCharacters = await this.getAllCharacters(realm.name);

        res.render("character-quests.hbs", {
            title: `Armory - ${charData.name} - Quests`,
            ...this.makeSharedDataObject(realm, charData),
            data: {
                categories: questsByCategory,
                otherCharacters: allCharacters.filter(c => c.guid !== charData.guid)
            },
        });
    }

    public async questsCompare(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
        const realmName = req.params.realm;
        const charName = req.params.name;
        const otherRealmName = req.params.otherRealm;
        const otherCharName = req.params.otherName;

        const realm = this.armory.getRealm(realmName);
        const otherRealm = this.armory.getRealm(otherRealmName);
        if (realm === undefined || otherRealm === undefined) {
            return next(404);
        }

        const charData = await this.getCharacterData(realm, charName);
        const otherCharData = await this.getCharacterData(otherRealm, otherCharName);
        if (charData === null || otherCharData === null) {
            return next(404);
        }

        const charQuests = await this.getQuests(realm.name, charData.guid);
        const otherQuests = await this.getQuests(otherRealm.name, otherCharData.guid);

        // Group quests by category
        interface IQuestComparison {
            id: number;
            title: string;
            questLevel: number;
            char1Status?: 'Completed' | 'In Progress';
            char2Status?: 'Completed' | 'In Progress';
        }

        const categories: { [key: string]: IQuestComparison[] } = {};

        const addQuestsToCategories = (quests: IQuest[], source: 'char1Status' | 'char2Status') => {
            quests.forEach(quest => {
                const category = quest.questSortID > 0 ?
                    this.getZoneName(quest.questSortID) :
                    this.getProfessionName(quest.questSortID);

                if (!categories[category]) {
                    categories[category] = [];
                }

                const existingQuest = categories[category].find(q => q.id === quest.id);
                if (existingQuest) {
                    existingQuest[source] = quest.status;
                    // Remove quest if both characters have completed it
                    if (existingQuest.char1Status === 'Completed' && existingQuest.char2Status === 'Completed') {
                        categories[category] = categories[category].filter(q => q.id !== quest.id);
                    }
                } else {
                    categories[category].push({
                        id: quest.id,
                        title: quest.title,
                        questLevel: quest.questLevel,
                        [source]: quest.status
                    });
                }
            });
        };

        addQuestsToCategories(charQuests, 'char1Status');
        addQuestsToCategories(otherQuests, 'char2Status');

        // Get list of all characters
        const allCharacters = await this.getAllCharacters(realm.name);

        res.render("character-quests-compare.hbs", {
            title: `Armory - Quest Compare - ${charData.name} vs ${otherCharData.name}`,
            ...this.makeSharedDataObject(realm, charData),
            data: {
                categories: categories,
                char1: {
                    name: charData.name,
                    realm: realm.name
                },
                char2: {
                    name: otherCharData.name,
                    realm: otherRealm.name
                },
                otherCharacters: allCharacters.filter(c => c.guid !== charData.guid)
            },
        });
    }

    private async getReputations(realm: string, character: number): Promise<IReputation[]> {
        const [rows] = await this.armory.getCharactersDb(realm).query({
            sql: `
                SELECT faction, standing, flags
                FROM character_reputation
                WHERE guid = ?
                AND flags NOT IN (0, 4, 8)
                AND standing != 0
            `,
            values: [character],
            timeout: this.armory.config.dbQueryTimeout,
        });

        const reputations = [];
        for (const row of rows as RowDataPacket[]) {
            const factionInfo = await this.armory.dbc.faction().find(f => f.id === row.faction);
            if (factionInfo && factionInfo.reputationId >= 0) {
                reputations.push({
                    id: row.faction,
                    name: factionInfo.name,
                    standing: this.getReputationStanding(row.standing),
                    value: row.standing,
                    valueInGrade: this.getReputationInGrade(row.standing),
                    max: this.getReputationMax(row.standing),
                    expansionId: this.getExpansionId(row.faction)
                });
            }
        }

        return reputations;
    }

    private getReputationStanding(value: number): string {
        if (value < -6000) {
            return 'Hated'; // These are probably not correct, but I don't have a character to test against
        }
        if (value < -3000) {
            return 'Hostile'; // These are probably not correct, but I don't have a character to test against
        }
        if (value < 0) {
            return 'Unfriendly'; // These are probably not correct, but I don't have a character to test against
        }
        if (value < 1000) {
            return 'Neutral'; // These are probably not correct, but I don't have a character to test against
        }
        if (value < 6000) {
            return 'Friendly';
        }
        if (value < 19000) {
            return 'Honored';
        }
        if (value < 40000) {
            return 'Revered';
        }

        return 'Exalted'; // These are probably not correct, but I don't have a character to test against
    }

    private getReputationMax(value: number): number {
        if (value < -6000) {
            return -6000; // These are probably not correct, but I don't have a character to test against
        }
        if (value < -3000) {
            return -3000; // These are probably not correct, but I don't have a character to test against
        }
        if (value < 0) {
            return 0; // These are probably not correct, but I don't have a character to test against
        }
        if (value < 1000) {
            return 3000;
        }
        if (value < 6000) {
            return 6000;
        }
        if (value < 12000) {
            return 12000;
        }
        if (value < 21000) {
            return 21000;
        }

        return 40000; // This might not be right, but I dont have an exalted character to test against
    }

    private getReputationInGrade(value: number): number {
        if (value < -6000) {
            return value + 3000; // These are probably not correct, but I don't have a character to test against
        }
        if (value < -3000) {
            return value; // These are probably not correct, but I don't have a character to test against
        }
        if (value < 0) {
            return value; // These are probably not correct, but I don't have a character to test against
        }
        if (value < 1000) {
            return value + 2000; // These are probably not correct, but I don't have a character to test against
        }
        if (value < 6000) {
            return value - 1000;
        }
        if (value < 12000) {
            return value - 5900;  // For some reason I needed to remove an extra 100 from this one to get it to match the client
        }
        if (value < 21000) {
            return value - 16900; // For some reason I needed to remove an extra 100 from this one to get it to match the client
        }

        return value - 21100; // This might not be right, but I dont have an exalted character to test against
    }

    private getExpansionId(factionId: number): number {
        // Classic factions
        if (factionId < 900) {
            return 0;
        }
        // TBC factions
        if (factionId < 1100) {
            return 1;
        }

        // WotLK factions
        return 2;
    }

    private async getQuests(realm: string, character: number): Promise<IQuest[]> {
        // Get completed and rewarded quests
        const [completedRows] = await this.armory.getCharactersDb(realm).query({
            sql: `
                SELECT quest FROM (
                    SELECT quest FROM character_queststatus
                    WHERE guid = ? AND status = 1
                    UNION
                    SELECT quest FROM character_queststatus_rewarded
                    WHERE guid = ?
                ) AS completed_quests
            `,
            values: [character, character],
            timeout: this.armory.config.dbQueryTimeout,
        });

        // Get in progress quests
        const [inProgressRows] = await this.armory.getCharactersDb(realm).query({
            sql: `
                SELECT quest
                FROM character_queststatus
                WHERE guid = ? AND status = 3
            `,
            values: [character],
            timeout: this.armory.config.dbQueryTimeout,
        });

        const quests: IQuest[] = [];

        // Process completed quests
        for (const row of completedRows as RowDataPacket[]) {
            const questInfo = await this.getQuestInfo(row.quest);
            if (questInfo) {
                quests.push({
                    id: row.quest,
                    title: questInfo.title,
                    status: 'Completed',
                    minLevel: questInfo.minLevel,
                    questLevel: questInfo.questLevel,
                    questSortID: questInfo.questSortID
                });
            }
        }

        // Process in progress quests
        for (const row of inProgressRows as RowDataPacket[]) {
            const questInfo = await this.getQuestInfo(row.quest);
            if (questInfo) {
                quests.push({
                    id: row.quest,
                    title: questInfo.title,
                    status: 'In Progress',
                    minLevel: questInfo.minLevel,
                    questLevel: questInfo.questLevel,
                    questSortID: questInfo.questSortID
                });
            }
        }

        return quests;
    }

    private async getQuestInfo(questId: number): Promise<IQuest> {
        const [rows] = await this.armory.worldDb.query({
            sql: `
                SELECT ID, LogTitle as title, MinLevel as minLevel, QuestLevel as questLevel, QuestSortID as questSortID
                FROM quest_template
                WHERE ID = ?
            `,
            values: [questId],
            timeout: this.armory.config.dbQueryTimeout,
        });

        return rows[0];
    }

    private getZoneName(zoneId: number): string {
        this.areaById[zoneId]?.zoneName;

        return this.areaById[zoneId]?.zoneName || `Zone ${zoneId}`;
    }

    private getProfessionName(professionId: number): string {
        const questTypes = {
            // Negative IDs (Classes and Professions)
            // Classes
            "-61": "Warlock",
            "-81": "Warrior",
            "-82": "Shaman",
            "-141": "Paladin",
            "-161": "Mage",
            "-162": "Rogue",
            "-261": "Hunter",
            "-262": "Priest",
            "-263": "Druid",
            "-372": "Death Knight",
            // Professions
            "-24": "Herbalism",
            "-101": "Fishing",
            "-121": "Blacksmithing",
            "-181": "Alchemy",
            "-182": "Leatherworking",
            "-201": "Engineering",
            "-264": "Tailoring",
            "-304": "Cooking",
            "-324": "First Aid",
            "-371": "Inscription",
            "-373": "Jewelcrafting",
            "-762": "Riding",
            // Misc
            "-1": "Epic",
            "-21": "Wailing Caverns",
            "-22": "Seasonal",
            "-23": "Undercity",
            "-25": "Battlegrounds",
            "-41": "Uldaman",
            "-221": "Treasure Map",
            "-241": "Tournament",
            "-284": "Special",
            "-344": "Legendary",
            "-364": "Darkmoon Faire",
            "-365": "Ahn'Qiraj War",
            "-366": "Lunar Festival",
            "-367": "Reputation",
            "-368": "Invasion",
            "-369": "Midsummer",
            "-370": "Brewfest",
            "-374": "Noblegarden",
            "-375": "Pilgrim's Bounty",
            "-376": "Love is in the Air"
        };

        return questTypes[professionId] || `Category ${professionId}`;
    }

    private getQuestExpansionId(questLevel: number): number {
        if (questLevel <= 60) {
            return 0; // Classic
        }
        if (questLevel <= 70) {
            return 1; // TBC
        }

        return 2; // WotLK
    }

    public async achievements(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
        const realmName = req.params.realm;
        const charName = req.params.name;

        const realm = this.armory.getRealm(realmName);
        if (realm === undefined) {
            // Could not find realm
            return next(404);
        }

        const charData = await this.getCharacterData(realm, charName);
        if (charData === null) {
            // Could not find character
            return next(404);
        }

        res.render("character-achievements.hbs", {
            title: `Arla MMO Armory - ${charData.name} - Achievements`,
            ...this.makeSharedDataObject(realm, charData),
        });
    }

    public async achievementsData(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
        const realmName = req.params.realm;
        const character = parseInt(req.params.character) || -1;

        const realm = this.armory.getRealm(realmName);
        if (realm === undefined) {
            // Could not find realm
            return next(404);
        }

        const charData = await this.getCharacterData(realm, character);
        if (charData === null) {
            // Could not find character
            return next(404);
        }

        res.json({
            categories: await this.armory.dbc.achievementCategory().toArray(),
            ...(await this.getAchievements(realm.name, charData)),
        });
    }

    public async pvp(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
        const realmName = req.params.realm;
        const charName = req.params.name;

        const realm = this.armory.getRealm(realmName);
        if (realm === undefined) {
            // Could not find realm
            return next(404);
        }

        const charData = await this.getCharacterData(realm, charName);
        if (charData === null) {
            // Could not find character
            return next(404);
        }

        res.render("character-pvp.hbs", {
            title: `Arla MMO Armory - ${charData.name} - PvP`,
            realm: realm.name,
            ...this.makeSharedDataObject(realm, charData),
            faction: Utils.getFactionFromRaceId(charData.race),
            kills: await this.getPvpKills(realm.name, charData.guid),
            arenaTeams: await this.getArenaTeams(realm.name, charData.guid),
        });
    }

    private makeSharedDataObject(realm: IRealmConfig, charData: ICharacterData) {
        return {
            realm: realm.name,
            name: charData.name,
            guid: charData.guid,
            race: RaceDisplayName[charData.race],
            class: ClassDisplayName[charData.class],
            level: charData.level,
            online: charData.online === 1,
            guild: charData.guild,
            zone: charData.zone,
            zoneName: this.getZoneName(charData.zone),
        };
    }

    private async getCharacterData(realm: IRealmConfig, character: string | number): Promise<ICharacterData> {
        const where = typeof character === "string" ? "LOWER(`characters`.`name`) = LOWER(?)" : "`characters`.`guid` = ?";
        const [rows] = await this.armory.getCharactersDb(realm.name).query({
            sql: `
                SELECT \`characters\`.\`guid\`, \`characters\`.\`name\`, \`race\`, \`class\`, \`gender\`, \`level\`, \`skin\`, \`face\`, \`hairStyle\`, \`hairColor\`, \`facialStyle\`, \`playerFlags\`, \`online\`, \`map\`, \`zone\`, \`position_x\`, \`position_y\`, \`guild\`.\`name\` AS \`guild\`
                FROM \`characters\`
                LEFT JOIN \`guild_member\` ON \`guild_member\`.\`guid\` = \`characters\`.\`guid\`
                LEFT JOIN \`guild\` ON \`guild\`.\`guildid\` = \`guild_member\`.\`guildid\`
                LEFT JOIN \`${realm.authDatabase}\`.\`account_access\` ON \`account_access\`.\`id\` = \`characters\`.\`account\` AND \`account_access\`.\`RealmID\` IN (-1, ${realm.realmId}) AND \`account_access\`.\`gmlevel\` > 0
                WHERE
                    ${where}
                    AND (\`account_access\`.\`id\` IS NULL OR ? = 0)
            `,
            values: [character, this.armory.config.hideGameMasters ? 1 : 0],
            timeout: this.armory.config.dbQueryTimeout,
        });

        if ((rows as RowDataPacket[]).length === 0) {
            return null;
        }
        return rows[0];
    }

    private async getEquipmentData(realm: string, charGuid: number): Promise<IEquipmentData[]> {
        let [rows] = await this.armory.getCharactersDb(realm).query({
            sql: `
                SELECT
                    character_inventory.slot, item_instance.itemEntry, item_instance.flags, item_instance.enchantments, item_instance.randomPropertyId
                FROM character_inventory
                JOIN item_instance ON item_instance.guid = character_inventory.item
                WHERE character_inventory.guid = ? AND character_inventory.bag = 0 AND character_inventory.slot IN (0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18)
            `,
            values: [charGuid],
            timeout: this.armory.config.dbQueryTimeout,
        });

        const data = rows as RowDataPacket[] as IEquipmentData[];
        if (data.length === 0) {
            return [];
        }

        for (const row of data) {
            const item = await this.armory.dbc.item().find((item) => item.id === row.itemEntry);
            row.classId = item.classId;
            row.subclassId = item.subclassId;
        }

        [rows] = await this.armory.worldDb.query({
            sql: "SELECT entry, quality FROM item_template WHERE entry IN (?)",
            values: [data.map((row) => row.itemEntry)],
            timeout: this.armory.config.dbQueryTimeout,
        });
        for (const row of rows as RowDataPacket[]) {
            const item = data.find((item) => item.itemEntry === row.entry);
            item.quality = row.quality;
        }

        return data;
    }

    private async getMounts(realm: string, charGuid: number): Promise<IMount[]> {
        const [rows] = await this.armory.getCharactersDb(realm).query({
            sql: `
                SELECT spell
                FROM character_spell
                WHERE guid = ? AND spell IN (?)
            `,
            values: [charGuid, this.mountSpells],
            timeout: this.armory.config.dbQueryTimeout,
        });

        return (rows as RowDataPacket[]).map((row) => this.mountBySpellId[row.spell]).filter((m) => m !== undefined);
    }

    private parseEnchantmentsString(enchantments: string): number[] {
        return enchantments
            .trim()
            .split(" ")
            .map((enchant) => parseInt(enchant))
            .filter((enchant) => enchant !== 0);
    }

    private getGemsFromEnchantments(enchantments: string): number[] {
        return this.parseEnchantmentsString(enchantments)
            .filter((enchant) => enchant in this.enchantSrcItems && this.enchantSrcItems[enchant] in this.gemItems)
            .map((enchant) => this.enchantSrcItems[enchant]);
    }

    private filterEnchantments(item: number, enchantments: string): number[] {
        const socketBonus = this.itemSocketBonuses[item];
        return this.parseEnchantmentsString(enchantments).filter(
            (enchant) => enchant in this.enchantSrcItems && !(this.enchantSrcItems[enchant] in this.gemItems) && enchant !== socketBonus,
        );
    }

    private async getSkills(realm: string, character: number): Promise<ISkills[]> {
        const [rows] = await this.armory.getCharactersDb(realm).query({
            sql: `
                SELECT skill, value, max
                FROM character_skills
                WHERE guid = ?
            `,
            values: [character],
            timeout: this.armory.config.dbQueryTimeout,
        });

        const skills: { id: number, categoryId: number, skill: string; value: number; max: number }[] = [];
        for (const row of rows as RowDataPacket[]) {
            skills.push({
                id: row.skill,
                categoryId: this.skillById[row.skill].categoryId,
                skill: this.skillById[row.skill].name,
                value: row.value,
                max: row.max,
            });
        }

        return skills;
    }

    private async getTalents(realm: string, character: number): Promise<number[][]> {
        const [rows] = await this.armory.getCharactersDb(realm).query({
            sql: `
                SELECT spell, specMask
                FROM character_talent
                WHERE guid = ?
            `,
            values: [character],
            timeout: this.armory.config.dbQueryTimeout,
        });

        const talents: number[][] = [[], []];
        for (const row of rows as RowDataPacket[]) {
            if (row.specMask === 1 || row.specMask === 3) {
                talents[0].push(row.spell);
            }
            if (row.specMask === 2 || row.specMask === 3) {
                talents[1].push(row.spell);
            }
        }

        return talents;
    }

    private async getTalentTrees(classId: number) {
        const items = await this.armory.dbc
            .talentTab()
            .filter((tab) => tab.classMask === Math.pow(2, classId - 1))
            .map(async (tab) => {
                const icon = await this.armory.dbc.spellIcon().find((icon) => icon.id === tab.spellIconId);
                const spells = await this.armory.dbc
                    .talent()
                    .filter((row) => row.tabId === tab.id)
                    .map(async (row) => {
                        const spell = await this.armory.dbc.spell().find((spell) => spell.id === row.spellRank0);
                        const icon = await this.armory.dbc.spellIcon().find((icon) => icon.id === spell?.spellIconId);
                        return { ...row, icon: this.processSpellIconTexture(icon?.textureFilename ?? "") };
                    })
                    .toArray();
                return {
                    name: tab.nameLang0,
                    icon: this.processSpellIconTexture(icon.textureFilename),
                    spells: await Promise.all(spells),
                };
            })
            .toArray();
        return await Promise.all(items);
    }

    private processSpellIconTexture(texturePath: string): string {
        return texturePath.toLowerCase().replace("interface\\icons\\", "").replace("interface\\spellbook\\", "").replace(/\.$/, "");
    }

    private async getGlyphs(realm: string, character: number): Promise<number[][]> {
        const [rows] = await this.armory.getCharactersDb(realm).query({
            sql: `
                SELECT guid, talentGroup, glyph1, glyph2, glyph3, glyph4, glyph5, glyph6
                FROM character_glyphs
                WHERE guid = ?
            `,
            values: [character],
            timeout: this.armory.config.dbQueryTimeout,
        });

        const glyphs: number[][] = [[], []];
        for (const row of rows as RowDataPacket[]) {
            const glyphIds = [row.glyph1, row.glyph2, row.glyph3, row.glyph4, row.glyph5, row.glyph6].filter((id) => id !== 0);
            for (const glyphId of glyphIds) {
                const glyph = await this.armory.dbc.glyphProperties().find((g) => g.id === glyphId);
                if (glyph === undefined) {
                    continue;
                }
                glyphs[row.talentGroup].push(glyph.spellId);
            }
        }

        return glyphs;
    }

    private async getAchievements(
        realm: string,
        charData: ICharacterData,
    ): Promise<{ achievements: IAchievement[]; earned: { [key: number]: number } }> {
        const promises = await this.armory.dbc
            .achievement()
            .filter((ach) => ach.faction === -1 || ach.faction === Utils.getFactionFromRaceId(charData.race))
            .map(async (ach) => {
                const icon = await this.armory.dbc.spellIcon().find((icon) => icon.id === ach.iconId);
                return {
                    id: ach.id,
                    category: ach.category,
                    title: ach.titleLang0,
                    description: ach.descriptionLang0,
                    points: ach.points,
                    icon: this.processSpellIconTexture(icon?.textureFilename ?? ""),
                };
            })
            .toArray();
        const achievements = await Promise.all(promises);

        const [rows] = await this.armory.getCharactersDb(realm).query({
            sql: `
                SELECT achievement, date
                FROM character_achievement
                WHERE guid = ?
            `,
            values: [charData.guid],
            timeout: this.armory.config.dbQueryTimeout,
        });
        const earned: { [key: number]: number } = {};
        for (const row of rows as RowDataPacket[]) {
            earned[row.achievement] = row.date;
        }

        return {
            achievements,
            earned,
        };
    }

    private async getPvpKills(realm: string, charGuid: number): Promise<{ total: number; today: number; yesterday: number }> {
        const [rows] = await this.armory.getCharactersDb(realm).query({
            sql: `
                SELECT totalKills, todayKills, yesterdayKills
                FROM characters
                WHERE guid = ?
            `,
            values: [charGuid],
            timeout: this.armory.config.dbQueryTimeout,
        });
        const row = rows[0];

        return {
            total: row.totalKills,
            today: row.todayKills,
            yesterday: row.yesterdayKills,
        };
    }

    private async getArenaTeams(realm: string, charGuid: number): Promise<IArenaTeam[]> {
        const [rows] = await this.armory.getCharactersDb(realm).query({
            sql: `
                SELECT
                    arena_team.arenaTeamId AS id, arena_team.name, arena_team.type, arena_team.rating, arena_team.seasonWins, arena_team.seasonGames,
                    arena_team.backgroundColor AS background, arena_team.emblemStyle, arena_team.emblemColor, arena_team.borderStyle, arena_team.borderColor
                FROM arena_team_member
                LEFT JOIN arena_team ON arena_team_member.arenaTeamId = arena_team.arenaTeamId
                WHERE guid = ?
                ORDER BY arena_team.type ASC
            `,
            values: [charGuid],
            timeout: this.armory.config.dbQueryTimeout,
        });

        return (rows as IArenaTeam[]).map((row) => {
            row.emblem = Utils.makeEmblemObject(row, false);
            return row;
        });
    }

    private async getAllCharacters(currentRealm: string): Promise<Array<{name: string, realmName: string, guid: number}>> {
        const [rows] = await this.armory.getCharactersDb(currentRealm).query({
            sql: `SELECT name, guid
                FROM characters
                    LEFT JOIN acore_auth.account ON account.id = characters.account
                    LEFT JOIN acore_auth.account_access ON account_access.id = characters.account AND account_access.gmlevel > 0
                WHERE level > 1
                    AND account.username NOT LIKE 'RNDBOT%'
                    AND account.username != 'AHBOT'
                    AND account_access.id IS NULL
                ORDER BY name ASC`,
            timeout: this.armory.config.dbQueryTimeout,
        });

        return (rows as RowDataPacket[]).map(row => ({
            name: row.name,
            guid: row.guid,
            realmName: currentRealm
        }));
    }
}
