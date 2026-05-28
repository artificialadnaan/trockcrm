import { describe, expect, it } from "vitest";
import {
  CANONICAL_PROJECT_NUMBER_REGEX_STRICT,
  PROJECT_NUMBER_MAX_LENGTH,
  ProjectNumberValidationError,
  isAcceptedProjectNumber,
  isStrictCanonicalProjectNumber,
  normalizeProjectNumberInput,
} from "../../../src/modules/deals/project-number-validation.js";

// Regression oracle: every distinct project_number in office_dallas.deals that does
// NOT match the strict canonical generator format, as verified against production.
// These are project-number strings (not customer/rep PII) and the ACCEPTED validator
// must never reject any of them. Two values legitimately contain internal whitespace
// and/or an embedded description.
const HISTORICAL_PROJECT_NUMBERS: string[] = [
  "01-TBR-RESPROP-080725",
  "1-HPL1-081425",
  "1-LGP.#1-090425",
  "1-PKH-#1RPM-091225",
  "1-PPW.1-08212025",
  "1-PTW.1-101025",
  "1-RBR.1-093025",
  "1-RNA.1-073125",
  "1-SVE.1.-101025",
  "1-THR.1-FCP-092425",
  "1-TLV.1-091625",
  "1-TND.1-081425",
  "2-AVP3-121225",
  "2-CAR4-011626",
  "2-CSA10-121125",
  "2-CSA14-010926",
  "2-CSA8-120325",
  "2-CWS.1-101325",
  "2-GRT-ASCENT-081225",
  "2-GTE.1-091225",
  "2-HEN1-111325",
  "2-JOV.1-100125",
  "2-JOV.1-100625",
  "2-MMC-WINNCO-090525-Garage door Repair",
  "2-MPA1-100225",
  "2-NLW1-111025",
  "2-POA1-111325",
  "2-PPA.Assetliving-081125",
  "2-PWA3-010526",
  "2-R@37-011426",
  "2-R@372-111225",
  "2-R@373-111725",
  "2-R@375-011926",
  "2-RBL-Rise48- 092425",
  "2-RBL-Rise48-092525-2",
  "2-RBL-Rise48-092525-3",
  "2-RHP1-121825",
  "2-RHR1-091525",
  "2-RSP3-011426",
  "2-SLA.5-101525",
  "2-STAR-RPM-081825",
  "2-SVA.1-102725",
  "2-SVA2-110425",
  "2-SVA3-011526",
  "2-TAT2-120225",
  "2-TBA3-121825",
  "2-TCF.1-101025",
  "2-TEA1-111325",
  "2-TKD.1-101625",
  "2-TLV-Lowcountry-082625",
  "2-TLV-lowcountry-082725",
  "2-TON1-121525",
  "2-TOT1-112125",
  "2-TOW1-120425",
  "2-TPL3-121525",
  "2-TPL7-123025",
  "2-TPL-Lowcountry-082025",
  "2-TPW1-120525",
  "2-VAB-RPM-080625",
  "4-JOV1-110325",
  "4-RSP4-012026",
  "4-TLP6-012126",
  "7-5001-111125",
  "AS21OURENO",
  "ASASWCRPNT",
  "ASCRCLBHOU",
  "ASCSMLEASE",
  "ASDEVONDRAIN",
  "ASDSTERMIN",
  "ASDTWCARPT",
  "ASECEPAINT",
  "ASFCDR1801",
  "ASFCEXTUPD",
  "ASGELIGHTS",
  "ASGRSUBFLR",
  "ASGWELIGHT",
  "ASHCCITWLK",
  "ASHMCLUREN",
  "ASHPCLUREN",
  "ASHWCLUBHS",
  "ASJNCOMPEN",
  "ASJONE2109",
  "ASJONESBAL",
  "ASLACRENOV",
  "ASLARGENER",
  "ASLWCARPEN",
  "ASMAABALCO",
  "ASMCORRIDR",
  "ASMLCBULBS",
  "ASMLCSTUCO",
  "ASMLCSTUCO1",
  "ASMORCARPP",
  "ASMRVRWALK",
  "ASONETRIM",
  "ASOSLASPLT",
  "ASPCPEXPNT",
  "ASPPEPAINT",
  "ASPPEPAINT1",
  "ASPPRENOVA",
  "ASR48SODD",
  "ASRHTROOFS",
  "ASRPMBKHSW",
  "ASRPMBLKSW",
  "ASRPMBNTSW",
  "ASRPMBRNGA",
  "ASRPMBRNSW",
  "ASRPMBXTSW",
  "ASRPMEVPKR",
  "ASRPMJNMB",
  "ASRTECHMN",
  "ASRTELIGHT",
  "ASRTFIRE",
  "ASRTRROOFS",
  "ASS28RECLD",
  "ASSCSMEXTR",
  "ASSLSWALL",
  "ASSTCPAINT",
  "ASTJCRPTRY",
  "ASWCPARKP1",
  "ASWMLIGHTS",
  "CB4110GALT",
  "CB4110GATE",
  "CBANTHWIND",
  "CBBILTLAND",
  "CBFAIRFNGT",
  "CBFAIRMOUNTGARPAINT",
  "CBFAIRPARK",
  "CBFORSTCRK",
  "CBMAAGRPRF",
  "CBPIKEPILL",
  "CBSTARPEEW",
  "CBWTRCSTWN",
  "CHALTDOOR",
  "CHALTLIGHT",
  "CHERV",
  "DBACONASPH",
  "DBCCLEASNG",
  "DBCRLEASWL",
  "DBCSCONCRT",
  "DBEWAATTIC",
  "DBEWPICPUL",
  "DBEWRFTUNE",
  "DBJLDECKRP",
  "DBLPPICPUL",
  "DBMVOLRENO",
  "DBPAPRSVLV",
  "DBPEXTERIO",
  "DBQWFNDTIN",
  "DBTDBPAINT",
  "DBWACNCRES",
  "dfw-3-12626-ab",
  "dfw-4-12626-ac",
  "DFW-4-14026-AB",
  "DFW-a-05826-ad",
  "HSHPLCARPT",
  "HSHPLCORR",
  "HSHPLPAIN2",
  "JHBORETWAL",
  "JHHERITAGE",
  "JHHGLENLEAKS",
  "JHTERPIPE",
  "JHTSQUARELEAKS",
  "JHVOLARWINDOWS",
  "KMAASPAINT",
  "KMABBBALC",
  "KMCPLAYRENO",
  "KMESTATESDRAINS",
  "KMFQEXTRENO",
  "KMH",
  "KMHACLBPOL",
  "KMHACWALL",
  "KMHDRAIN",
  "KMHENLAD",
  "KMLPCORRID",
  "KMMBGUTTER",
  "KMMBRFLDOG",
  "KMMBUNITCO",
  "KMMRMAILBX",
  "KMPWINTERS",
  "KMQ10EPCPR",
  "KMRBINTREN",
  "KMRLASPHAT",
  "KMRLEXTREP",
  "KMRLRAILIN",
  "KMRPMEDISTR",
  "KMRPMEMPKR",
  "KMRPMTLVC",
  "KMTIDESNDDEMO",
  "KMTPARKLANEUNITS",
  "KMUNSTRFRT",
  "KWBSFENCER",
  "KWWFREPAIR",
  "RPMKMSHLDW",
  "RPMKMSOHMB",
  "THCWPCWDW",
  "THHARVARDWATER",
  "THIREGONGC",
  "THIREGWFRF",
  "THSCCLRENO",
  "TJAPCURBIN",
  "TM511ELECTRIC",
  "TMAAUNITBB",
  "TMABBEROOF",
  "TMAOCLBHSE",
  "TMARCBUSINESS",
  "TMARCFACADE",
  "TMASCLBHSE",
  "TMAWINDOWS",
  "TMBAALUMIN",
  "TMBMCAPX26",
  "TMBPCARPNT",
  "TMCBSDD",
  "TMCENTRALLANDINGS",
  "TMCHRECLAD",
  "TMCPNTCARP",
  "TMCRCCON",
  "TMCRPRKGAR",
  "TMDRKAWNING",
  "TMDSHROOFR",
  "TMECCLBHSE",
  "TMEPGARAGE",
  "TMFFMROOF",
  "TMGATEMAILBOX",
  "TMGSSEAL",
  "TMHNCARPNT",
  "TMHNCHIMNY",
  "TMJASBLDG18",
  "TMLBASPHALT",
  "TMLEXTPAINT",
  "TMLGPCAPEX",
  "TMLGPPERGWALL",
  "TMLPAATTIC",
  "TMLPPRKGAR",
  "TMLRPRKGAR",
  "TMMIDDEMO",
  "TMMIDTOWNCAP",
  "TMMPEXTCAR",
  "TMMPGUTTER",
  "TMMPROOFRP",
  "TMMROOFREP",
  "TMPPWGARAGE",
  "TMPPWMAILDR",
  "TMPREXTCARP",
  "TMPWADDEXT",
  "TMPWORIEXT",
  "TMRCACPPNT",
  "TMRCEXTRDD",
  "TMROOFPALADIN",
  "TMRPCAPX26",
  "TMSILVERDCWDHW",
  "TMSILVREPIPE",
  "TMSLSTAIRS",
  "TMSPREROOF",
  "TMTLV3ROOF",
  "TMTMEXTRPR",
  "TMTPLHVAC",
  "TMTTSTARP1",
  "TMTTUNTBLD",
  "TMTWCINTER",
  "TMVSHASPHT",
  "TMVSTRTREP",
  "TMWANWROOF",
  "TMWBALCONY",
  "TMWCARPPNT",
  "TMWEXTRENO",
  "TMWMWATVLV",
  "TMWOEDRAIN",
  "TMWOEFOUNDATION",
  "TMWOEUNITS",
  "TMWPREBULD",
  "TMWTRCHSBA",
  "TRPPBRCLUB",
];

// Build control-char test strings via char codes so no invisible control bytes ever
// live in this source file.
const NUL = String.fromCharCode(0);
const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
const DEL = String.fromCharCode(127);

describe("CANONICAL_PROJECT_NUMBER_REGEX_STRICT (governs generated numbers)", () => {
  it("accepts single-digit non-zero project-type codes with one or more lowercase suffix letters", () => {
    expect(CANONICAL_PROJECT_NUMBER_REGEX_STRICT.test("DFW-1-12345-a")).toBe(true);
    expect(CANONICAL_PROJECT_NUMBER_REGEX_STRICT.test("DFW-1-12345-aa")).toBe(true);
    expect(CANONICAL_PROJECT_NUMBER_REGEX_STRICT.test("DFW-1-12345-aaa")).toBe(true);
    expect(CANONICAL_PROJECT_NUMBER_REGEX_STRICT.test("ATL-9-54321-z")).toBe(true);
  });

  it("rejects zero or multi-digit project-type codes (single non-zero digit invariant)", () => {
    expect(CANONICAL_PROJECT_NUMBER_REGEX_STRICT.test("DFW-0-12345-a")).toBe(false);
    expect(CANONICAL_PROJECT_NUMBER_REGEX_STRICT.test("DFW-12-12345-a")).toBe(false);
    expect(CANONICAL_PROJECT_NUMBER_REGEX_STRICT.test("DFW-a-12345-a")).toBe(false);
  });

  it("rejects non-five-digit numeric components", () => {
    expect(CANONICAL_PROJECT_NUMBER_REGEX_STRICT.test("DFW-1-1234-a")).toBe(false);
    expect(CANONICAL_PROJECT_NUMBER_REGEX_STRICT.test("DFW-1-123456-a")).toBe(false);
  });

  it("rejects uppercase letters or empty suffixes", () => {
    expect(CANONICAL_PROJECT_NUMBER_REGEX_STRICT.test("DFW-1-12345-A")).toBe(false);
    expect(CANONICAL_PROJECT_NUMBER_REGEX_STRICT.test("DFW-1-12345-")).toBe(false);
  });

  it("rejects non-DFW/ATL office prefixes and non-uppercase forms", () => {
    expect(CANONICAL_PROJECT_NUMBER_REGEX_STRICT.test("HOU-1-12345-a")).toBe(false);
    expect(CANONICAL_PROJECT_NUMBER_REGEX_STRICT.test("dfw-1-12345-a")).toBe(false);
  });
});

describe("isAcceptedProjectNumber — accepts every historical production format", () => {
  it("has the expected number of historical fixtures (guards against accidental edits)", () => {
    expect(HISTORICAL_PROJECT_NUMBERS).toHaveLength(272);
  });

  it("accepts ALL 272 historical (non-strict) production project numbers after trim", () => {
    const rejected = HISTORICAL_PROJECT_NUMBERS.filter(
      (value) => !isAcceptedProjectNumber(value.trim())
    );
    // Fail loudly with the exact list of any value the validator would wrongly reject.
    expect(rejected).toEqual([]);
  });

  it("accepts the strict canonical form too", () => {
    expect(isAcceptedProjectNumber("DFW-1-12345-a")).toBe(true);
    expect(isAcceptedProjectNumber("ATL-2-54321-ab")).toBe(true);
  });

  it("accepts a value with an internal space and an embedded description", () => {
    expect(isAcceptedProjectNumber("2-MMC-WINNCO-090525-Garage door Repair")).toBe(true);
  });

  it("accepts short codes the old per-format approach wrongly rejected", () => {
    // These exist in production and were rejected by the round-6 regex union.
    expect(isAcceptedProjectNumber("KMH")).toBe(true);
    expect(isAcceptedProjectNumber("CHERV")).toBe(true);
    expect(isAcceptedProjectNumber("2-R@37-011426")).toBe(true);
    expect(isAcceptedProjectNumber("1-LGP.#1-090425")).toBe(true);
    expect(isAcceptedProjectNumber("dfw-3-12626-ab")).toBe(true);
    expect(isAcceptedProjectNumber("DFW-4-14026-AB")).toBe(true);
  });

  it("accepts a value exactly at the length bound and rejects one over it", () => {
    expect(isAcceptedProjectNumber("a".repeat(PROJECT_NUMBER_MAX_LENGTH))).toBe(true);
    expect(isAcceptedProjectNumber("a".repeat(PROJECT_NUMBER_MAX_LENGTH + 1))).toBe(false);
  });

  it("rejects empty, whitespace-only, and non-string inputs", () => {
    expect(isAcceptedProjectNumber("")).toBe(false);
    expect(isAcceptedProjectNumber("   ")).toBe(false);
    expect(isAcceptedProjectNumber(null)).toBe(false);
    expect(isAcceptedProjectNumber(undefined)).toBe(false);
    expect(isAcceptedProjectNumber(42)).toBe(false);
  });

  it("rejects values containing ASCII control characters", () => {
    expect(isAcceptedProjectNumber(`${NUL}abc`)).toBe(false);
    expect(isAcceptedProjectNumber(`ab${TAB}cd`)).toBe(false);
    expect(isAcceptedProjectNumber(`ab${LF}cd`)).toBe(false);
    expect(isAcceptedProjectNumber(`abc${DEL}`)).toBe(false);
  });
});

describe("isStrictCanonicalProjectNumber", () => {
  it("matches the strict regex only", () => {
    expect(isStrictCanonicalProjectNumber("DFW-1-12345-a")).toBe(true);
    expect(isStrictCanonicalProjectNumber("DFW-a-12345-aa")).toBe(false);
    expect(isStrictCanonicalProjectNumber("KMPWINTERS")).toBe(false);
  });
});

describe("normalizeProjectNumberInput", () => {
  it("returns null for nullish input", () => {
    expect(normalizeProjectNumberInput(null)).toBeNull();
    expect(normalizeProjectNumberInput(undefined)).toBeNull();
  });

  it("coerces blank/whitespace-only input to null instead of throwing", () => {
    expect(normalizeProjectNumberInput("")).toBeNull();
    expect(normalizeProjectNumberInput("   ")).toBeNull();
    expect(normalizeProjectNumberInput(`${TAB}  ${LF}`)).toBeNull();
  });

  it("trims outer whitespace and accepts the strict canonical form", () => {
    expect(normalizeProjectNumberInput("  DFW-1-12345-aa  ")).toBe("DFW-1-12345-aa");
  });

  it("accepts historical legacy formats unchanged", () => {
    expect(normalizeProjectNumberInput("KMPWINTERS")).toBe("KMPWINTERS");
    expect(normalizeProjectNumberInput("1-TLV.1-091625")).toBe("1-TLV.1-091625");
    expect(normalizeProjectNumberInput("DFW-a-05826-ad")).toBe("DFW-a-05826-ad");
    expect(normalizeProjectNumberInput("KMH")).toBe("KMH");
    expect(normalizeProjectNumberInput("2-R@37-011426")).toBe("2-R@37-011426");
  });

  it("strips only outer whitespace and preserves internal characters", () => {
    // Internal space preserved, embedded description retained.
    expect(normalizeProjectNumberInput("2-MMC-WINNCO-090525-Garage door Repair")).toBe(
      "2-MMC-WINNCO-090525-Garage door Repair"
    );
    // Outer whitespace stripped, internal space retained.
    expect(normalizeProjectNumberInput("  2-RBL-Rise48- 092425  ")).toBe(
      "2-RBL-Rise48- 092425"
    );
  });

  it("throws ProjectNumberValidationError on non-string input", () => {
    expect(() => normalizeProjectNumberInput(42 as unknown)).toThrow(ProjectNumberValidationError);
  });

  it("throws ProjectNumberValidationError on input over the length bound", () => {
    const oversized = "a".repeat(PROJECT_NUMBER_MAX_LENGTH + 1);
    expect(() => normalizeProjectNumberInput(oversized)).toThrow(ProjectNumberValidationError);
  });

  it("throws ProjectNumberValidationError on input containing control characters", () => {
    expect(() => normalizeProjectNumberInput(`abc${NUL}def`)).toThrow(ProjectNumberValidationError);
  });
});
