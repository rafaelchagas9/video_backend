import { mkdir, readFile, rename, stat, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

type DemoDownload = {
  id: string;
  title: string;
  description: string;
  themes: string;
  creators: string[];
  studios: string[];
  tags: string[];
};

const HD_FORMAT =
  "bv*[ext=webm][height<=1080]+ba[ext=webm]/b[ext=webm][height<=1080]";
const AV1_HD_FALLBACK =
  "bv*[vcodec^=av01][height<=1080]+ba[acodec=opus]/b[vcodec^=av01][height<=1080]";

const DOWNLOADS: DemoDownload[] = [
  {
    id: "e3D7Fj1PsWk",
    title: "Salvation - For Demacia 2026 Cinematic",
    description:
      "Demacia faces its darkest hour in a sweeping season cinematic built around sacrifice, resolve, and a last beacon of hope.",
    themes: "Demacia, War, Hope, Magic",
    creators: ["Forts"],
    studios: ["Riot Games"],
    tags: ["Cinematic", "Action", "Gaming", "Fantasy", "Music Video"],
  },
  {
    id: "I76wvt0aEE4",
    title: "Welcome to Noxus - Bite Marks",
    description:
      "A brutal Fortiche-produced journey into Noxus where ambition, strength, and political violence collide.",
    themes: "Noxus, Ambition, War, Power",
    creators: ["TEYA"],
    studios: ["Riot Games", "Fortiche Production"],
    tags: ["Cinematic", "Action", "Gaming", "Fantasy", "Music Video"],
  },
  {
    id: "ZHhqwBwmRkI",
    title: "Still Here - Season 2024 Cinematic",
    description:
      "Past, present, and possible futures collide as iconic champions fight for what tomorrow might become.",
    themes: "Legacy, Future, Sacrifice, War",
    creators: ["Forts", "Tiffany Aris", "2WEI"],
    studios: ["Riot Games"],
    tags: ["Cinematic", "Action", "Gaming", "Fantasy", "Music Video"],
  },
  {
    id: "mDYqT0_9VR4",
    title: "The Call - Season 2022 Cinematic",
    description:
      "Warriors across Runeterra answer a shared call to rise again in a large-scale fantasy battle cinematic.",
    themes: "Ascension, War, Gods, Perseverance",
    creators: ["2WEI", "Edda Hayes"],
    studios: ["Riot Games"],
    tags: ["Cinematic", "Action", "Gaming", "Fantasy", "Music Video"],
  },
  {
    id: "fB8TyLTD7EE",
    title: "RISE - Worlds 2018",
    description:
      "An esports champion relives a climb through legendary rivals in one of League of Legends' defining Worlds cinematics.",
    themes: "Esports, Ambition, Competition, Legends",
    creators: ["The Glitch Mob", "Mako", "The Word Alive"],
    studios: ["Riot Games"],
    tags: ["Cinematic", "Action", "Gaming", "Music Video"],
  },
  {
    id: "mNd1gb19A-c",
    title: "Resident Evil - Official 4K Trailer",
    description:
      "A tense return to survival horror filled with infected threats, isolation, and escalating dread.",
    themes: "Outbreak, Survival, Infection, Fear",
    creators: [],
    studios: ["Sony Pictures"],
    tags: ["Trailer", "Horror", "Action"],
  },
  {
    id: "irVNGjRFZGk",
    title: "Avengers: Doomsday - Official Trailer",
    description:
      "Marvel heroes converge against a world-ending threat in a large-scale superhero event trailer.",
    themes: "Heroes, Multiverse, Doom, Sacrifice",
    creators: ["Robert Downey Jr.", "Pedro Pascal"],
    studios: ["Marvel Studios"],
    tags: ["Trailer", "Action", "Sci-Fi", "Superhero"],
  },
  {
    id: "dIQGI36BxDE",
    title: "God of War Ragnarök - Father and Son",
    description:
      "Kratos and Atreus confront fate, family, and the coming of Ragnarök in a concise cinematic trailer.",
    themes: "Mythology, Family, Fate, War",
    creators: [],
    studios: ["Santa Monica Studio"],
    tags: ["Trailer", "Cinematic", "Action", "Gaming", "Fantasy"],
  },
  {
    id: "taNGuF_k5Ao",
    title: "Assassin's Creed Unity - World Premiere",
    description:
      "Four assassins move through revolutionary Paris in a cinematic built around uprising, brotherhood, and precision.",
    themes: "Revolution, Brotherhood, Paris, History",
    creators: [],
    studios: ["Ubisoft"],
    tags: ["Trailer", "Cinematic", "Action", "Gaming", "Historical"],
  },
  {
    id: "C3E358n7pcI",
    title: "Transformers: Fall of Cybertron - VGA Cinematic",
    description:
      "Autobots and Decepticons clash during Cybertron's final hours in an operatic science-fiction game cinematic.",
    themes: "Cybertron, War, Robots, Exodus",
    creators: [],
    studios: ["High Moon Studios", "Activision"],
    tags: ["Trailer", "Cinematic", "Action", "Gaming", "Sci-Fi"],
  },
  {
    id: "XaI-EOVpDvo",
    title: "The Elder Scrolls Online: High Isle - Launch Cinematic",
    description:
      "Armored rivals collide amid a Breton conspiracy in a polished fantasy launch cinematic.",
    themes: "Bretons, Knights, Intrigue, War",
    creators: [],
    studios: ["ZeniMax Online Studios", "Bethesda Softworks"],
    tags: ["Trailer", "Cinematic", "Action", "Gaming", "Fantasy"],
  },
  {
    id: "jSJr3dXZfcg",
    title: "World of Warcraft: Battle for Azeroth",
    description:
      "The Alliance and Horde erupt into open war in Blizzard's iconic faction-versus-faction cinematic.",
    themes: "Alliance, Horde, War, Honor",
    creators: [],
    studios: ["Blizzard Entertainment"],
    tags: ["Trailer", "Cinematic", "Action", "Gaming", "Fantasy"],
  },
  {
    id: "ZSWN-VP0lD8",
    title: "Destiny - Become Legend",
    description:
      "A fireteam crosses the Solar System in a playful live-action trailer packed with alien combat and swagger.",
    themes: "Space, Fireteam, Aliens, Adventure",
    creators: [],
    studios: ["Bungie", "PlayStation"],
    tags: ["Trailer", "Action", "Gaming", "Sci-Fi", "Space"],
  },
  {
    id: "gMC8kkwbIQQ",
    title: "Obsession - Official Trailer",
    description:
      "A Blumhouse romantic-horror trailer where desire curdles into something dangerous and supernatural.",
    themes: "Obsession, Romance, Horror, Supernatural",
    creators: [],
    studios: ["Blumhouse"],
    tags: ["Trailer", "Horror", "Thriller"],
  },
  {
    id: "zO3nTu4rCKQ",
    title: "We Are Charlie Kirk - Chinese Version",
    description:
      "A surreal Chinese-language internet remix that adds an intentionally strange corner to the demo catalog.",
    themes: "Internet, Satire, Politics, Remix",
    creators: ["Grand Leader Macron"],
    studios: [],
    tags: ["Music Video", "Internet", "Comedy"],
  },
  {
    id: "JmnZHQNN5cc",
    title: "Caroline Polachek - Tiny Desk Concert",
    description:
      "Caroline Polachek brings art-pop vocals and inventive arrangements into NPR's intimate performance space.",
    themes: "Art Pop, Voice, Intimacy, Performance",
    creators: ["Caroline Polachek"],
    studios: ["NPR Music"],
    tags: ["Live Music", "Concert", "Pop"],
  },
  {
    id: "eVcBFTAh0co",
    title: "Mia Rodriguez - Psycho (Acoustic)",
    description:
      "An official stripped-back acoustic performance of Psycho by Mia Rodriguez.",
    themes: "Acoustic, Dark Pop, Voice, Intimacy",
    creators: ["Mia Rodriguez"],
    studios: [],
    tags: ["Music Video", "Live Music", "Acoustic", "Pop"],
  },
  {
    id: "ZDwDCUrd2KE",
    title: "JADE - Tiny Desk Concert",
    description:
      "JADE reshapes her pop catalog for a compact live set at the Tiny Desk.",
    themes: "Pop, Performance, Voice, Reinvention",
    creators: ["JADE"],
    studios: ["NPR Music"],
    tags: ["Live Music", "Concert", "Pop"],
  },
  {
    id: "d25O8USd35Y",
    title: "Tim Bernardes - Tiny Desk Brasil",
    description:
      "Tim Bernardes performs an intimate Brazilian set with delicate arrangements and close-up musicianship.",
    themes: "Brazil, Songwriting, Intimacy, Performance",
    creators: ["Tim Bernardes"],
    studios: ["Tiny Desk Brasil"],
    tags: ["Live Music", "Concert", "Brazilian", "Acoustic"],
  },
  {
    id: "ouuPSxE1hK4",
    title: "Bad Bunny - Tiny Desk Concert",
    description:
      "Bad Bunny brings a warm, expansive Latin performance to NPR's Tiny Desk.",
    themes: "Puerto Rico, Latin Music, Performance, Celebration",
    creators: ["Bad Bunny"],
    studios: ["NPR Music"],
    tags: ["Live Music", "Concert", "Pop", "Hip-Hop"],
  },
  {
    id: "y-PLr-BPxKU",
    title: "Nelly Furtado - Tiny Desk Concert",
    description:
      "Nelly Furtado revisits a wide-ranging pop catalog in an intimate live arrangement.",
    themes: "Pop, Nostalgia, Voice, Performance",
    creators: ["Nelly Furtado"],
    studios: ["NPR Music"],
    tags: ["Live Music", "Concert", "Pop"],
  },
  {
    id: "FftvVi42U4o",
    title: "Becky G - Tiny Desk Concert",
    description:
      "Becky G performs a bilingual set spanning pop, Latin rhythms, and personal storytelling.",
    themes: "Latin Music, Identity, Pop, Performance",
    creators: ["Becky G"],
    studios: ["NPR Music"],
    tags: ["Live Music", "Concert", "Pop"],
  },
  {
    id: "y38qQRg3UDI",
    title: "Dua Lipa - Tiny Desk Concert",
    description:
      "Dua Lipa turns polished dance-pop songs into a vivid live-band Tiny Desk set.",
    themes: "Dance Pop, Live Band, Performance, Voice",
    creators: ["Dua Lipa"],
    studios: ["NPR Music"],
    tags: ["Live Music", "Concert", "Pop"],
  },
  {
    id: "ox1Eemj8FDo",
    title: "Charli xcx - Rock Music",
    description:
      "Charli xcx pushes pop into abrasive guitar textures in an official visual built for the song's raw energy.",
    themes: "Rock, Pop, Distortion, Performance",
    creators: ["Charli xcx"],
    studios: [],
    tags: ["Music Video", "Pop", "Rock"],
  },
  {
    id: "k6v3vFLig9c",
    title: "Violino Subverso",
    description:
      "GP DA ZL, Jhow MC, and Mc Makauli collide over a dramatic violin-led Brazilian funk production.",
    themes: "Brazil, Funk, Violin, Street Music",
    creators: ["GP DA ZL", "Jhow MC", "Mc Makauli"],
    studios: ["GP DA ZL"],
    tags: ["Music Video", "Brazilian", "Hip-Hop"],
  },
  {
    id: "aSugSGCC12I",
    title: "Sabrina Carpenter - Manchild",
    description:
      "Sabrina Carpenter turns a chaotic road trip into a playful, sharply styled official pop video.",
    themes: "Pop, Humor, Road Trip, Performance",
    creators: ["Sabrina Carpenter"],
    studios: [],
    tags: ["Music Video", "Pop", "Comedy"],
  },
  {
    id: "66PrK9b_WD8",
    title: "Pitty - Me Adora",
    description:
      "Pitty's defiant Brazilian rock staple in its official music-video form.",
    themes: "Defiance, Rock, Brazil, Identity",
    creators: ["Pitty"],
    studios: [],
    tags: ["Music Video", "Brazilian", "Rock"],
  },
  {
    id: "V_-Fo9eoASc",
    title: "Qveen Herby - High Priestess",
    description:
      "Qveen Herby mixes theatrical styling, rapid-fire delivery, and occult-pop imagery.",
    themes: "Power, Ritual, Style, Confidence",
    creators: ["Qveen Herby"],
    studios: [],
    tags: ["Music Video", "Pop", "Hip-Hop"],
  },
  {
    id: "GR3Liudev18",
    title: "Chappell Roan - Pink Pony Club",
    description:
      "Chappell Roan's official queer-pop anthem pairs theatrical performance with a vivid club fantasy.",
    themes: "Queer Joy, Performance, Freedom, Pop",
    creators: ["Chappell Roan"],
    studios: [],
    tags: ["Music Video", "Pop"],
  },
  {
    id: "xGRH6MvX2Oo",
    title: "The Warning - Kerosene",
    description:
      "The Warning deliver a forceful official rock video driven by explosive trio chemistry.",
    themes: "Rock, Fire, Energy, Performance",
    creators: ["The Warning"],
    studios: [],
    tags: ["Music Video", "Rock"],
  },
  {
    id: "uvY8fdgezLQ",
    title: "Zara Larsson - Midnight Sun",
    description:
      "Zara Larsson pairs luminous Scandinavian summer imagery with a sleek official pop production.",
    themes: "Summer, Light, Pop, Performance",
    creators: ["Zara Larsson"],
    studios: [],
    tags: ["Music Video", "Pop"],
  },
  {
    id: "162UjvpgGbk",
    title: "Dupê - Cabaré em Chicago (Live Action)",
    description:
      "Dupê's live-action Cabaré em Chicago adds independent Brazilian genre-mixing to the demo library.",
    themes: "Brazil, Cabaret, Independent Music, Performance",
    creators: ["Dupê"],
    studios: [],
    tags: ["Music Video", "Brazilian", "Hip-Hop"],
  },
  {
    id: "KWoTyfPsqbE",
    title: "Sabrina Carpenter - House Tour",
    description:
      "Sabrina Carpenter turns a glamorous house tour into a playful, meticulously staged official pop video.",
    themes: "Hollywood, Fantasy, Glamour, Pop",
    creators: ["Sabrina Carpenter"],
    studios: [],
    tags: ["Music Video", "Pop", "Comedy"],
  },
  {
    id: "LNlrGhBpYjc",
    title: "The Substance - Official Trailer",
    description:
      "Margaret Qualley and Demi Moore confront fame, identity, and transformation in a vivid body-horror trailer.",
    themes: "Identity, Aging, Body Horror, Fame",
    creators: ["Margaret Qualley", "Demi Moore", "Dennis Quaid"],
    studios: ["MUBI"],
    tags: ["Trailer", "Horror", "Sci-Fi", "Drama"],
  },
];

const EXTRA_TAGS = [
  ["Fantasy", "Magic, mythology, and imaginative worlds.", "#8b5cf6"],
  ["Music Video", "Music-led visual storytelling and performance.", "#db2777"],
  [
    "Superhero",
    "Super-powered heroes, villains, and comic-book worlds.",
    "#2563eb",
  ],
  [
    "Historical",
    "Stories and settings inspired by historical periods.",
    "#a16207",
  ],
  [
    "Space",
    "Space travel, alien worlds, and interplanetary adventure.",
    "#4338ca",
  ],
  ["Live Music", "Live musical performances and sessions.", "#dc2626"],
  ["Concert", "Concerts and multi-song live sets.", "#be123c"],
  ["Pop", "Pop music and pop-centered performances.", "#ec4899"],
  ["Rock", "Rock music, bands, and guitar-driven performances.", "#78716c"],
  ["Brazilian", "Music and stories from Brazil.", "#16a34a"],
  ["Hip-Hop", "Rap, hip-hop, and related styles.", "#ca8a04"],
  ["Acoustic", "Stripped-back acoustic performances.", "#b45309"],
  ["Internet", "Internet-native culture, remix, and oddities.", "#0891b2"],
  ["Comedy", "Comedy, satire, and playful storytelling.", "#eab308"],
] as const;

const CHILD_TAGS = [
  [
    "Official Music Video",
    "Music Video",
    "Official artist music videos.",
    "#f472b6",
  ],
  [
    "Live Session",
    "Live Music",
    "Recorded live studio and session performances.",
    "#f87171",
  ],
  [
    "Tiny Desk",
    "Live Session",
    "Performances from the Tiny Desk format.",
    "#fb7185",
  ],
  [
    "Intimate Concert",
    "Concert",
    "Small-room and close-up concert performances.",
    "#e11d48",
  ],
  [
    "Pop Performance",
    "Pop",
    "Performance-focused contemporary pop.",
    "#f9a8d4",
  ],
  [
    "Alternative Rock",
    "Rock",
    "Alternative and modern guitar-driven rock.",
    "#a8a29e",
  ],
  [
    "Brazilian Music",
    "Brazilian",
    "Music created by Brazilian artists.",
    "#4ade80",
  ],
  [
    "Brazilian Funk",
    "Brazilian Music",
    "Brazilian funk and related street styles.",
    "#22c55e",
  ],
  [
    "Rap Performance",
    "Hip-Hop",
    "Rap-led songs and live performances.",
    "#facc15",
  ],
  [
    "Official Trailer",
    "Trailer",
    "Official promotional film and game trailers.",
    "#fb923c",
  ],
  [
    "Psychological Horror",
    "Horror",
    "Horror centered on perception and identity.",
    "#991b1b",
  ],
  ["Body Horror", "Horror", "Transformation and bodily horror.", "#7f1d1d"],
  [
    "Game Cinematic",
    "Gaming",
    "Narrative cinematics made for video games.",
    "#60a5fa",
  ],
  [
    "Epic Fantasy",
    "Fantasy",
    "Large-scale magical worlds and conflicts.",
    "#a78bfa",
  ],
  [
    "Combat",
    "Action",
    "Combat, battles, and physical confrontation.",
    "#f87171",
  ],
  [
    "Future Worlds",
    "Sci-Fi",
    "Speculative technology and future societies.",
    "#67e8f9",
  ],
  [
    "Satire & Humor",
    "Comedy",
    "Playful, ironic, and satirical work.",
    "#fde047",
  ],
  [
    "Acoustic Session",
    "Acoustic",
    "Stripped-back acoustic performances.",
    "#d97706",
  ],
  [
    "Internet Remix",
    "Internet",
    "Internet-native edits and musical remixes.",
    "#22d3ee",
  ],
  [
    "Animated Short",
    "Animation",
    "Short-form animated storytelling.",
    "#c084fc",
  ],
  [
    "Space Adventure",
    "Space",
    "Adventure across planets and space.",
    "#818cf8",
  ],
] as const;

const EXTRA_STUDIOS = [
  [
    "Fortiche Production",
    "Animation studio known for stylized Riot cinematics and Arcane.",
  ],
  ["Sony Pictures", "Global film studio and distributor."],
  [
    "Marvel Studios",
    "Film and television studio behind the Marvel Cinematic Universe.",
  ],
  ["Santa Monica Studio", "PlayStation studio and developer of God of War."],
  ["Ubisoft", "Game publisher and developer behind Assassin's Creed."],
  [
    "High Moon Studios",
    "Game studio known for Transformers: Fall of Cybertron.",
  ],
  ["Activision", "Video game publisher."],
  ["ZeniMax Online Studios", "Developer of The Elder Scrolls Online."],
  [
    "Bethesda Softworks",
    "Game publisher known for large-scale fantasy worlds.",
  ],
  ["Bungie", "Game studio behind Destiny."],
  ["PlayStation", "Gaming platform and publisher."],
  [
    "Blumhouse",
    "Film studio known for inventive horror and thriller productions.",
  ],
  ["NPR Music", "Music publisher and home of the Tiny Desk concert series."],
  [
    "Tiny Desk Brasil",
    "Brazilian edition of the intimate Tiny Desk concert format.",
  ],
  [
    "GP DA ZL",
    "Independent Brazilian music channel and production collective.",
  ],
  ["MUBI", "Film distributor, producer, and global streaming service."],
] as const;

const EXTRA_CREATORS = [
  [
    "Forts",
    "Vocalist featured in multiple League of Legends season cinematics.",
  ],
  ["TEYA", "Singer and songwriter featured in the Noxus season cinematic."],
  ["Tiffany Aris", "Vocalist featured in the Still Here season cinematic."],
  ["2WEI", "Composer duo known for cinematic trailer music."],
  ["Edda Hayes", "Vocalist featured in League of Legends cinematics."],
  ["The Glitch Mob", "Electronic music group featured on RISE."],
  ["Mako", "Singer, songwriter, and producer featured on RISE."],
  ["The Word Alive", "Rock band featured on RISE."],
  ["Robert Downey Jr.", "Actor appearing in Avengers: Doomsday."],
  ["Pedro Pascal", "Actor appearing in Avengers: Doomsday."],
  [
    "Grand Leader Macron",
    "Internet creator behind multilingual musical remixes.",
  ],
  ["Caroline Polachek", "American art-pop singer, songwriter, and producer."],
  [
    "Mia Rodriguez",
    "Australian singer and songwriter blending dark and alternative pop.",
  ],
  ["JADE", "British pop singer and songwriter."],
  ["Tim Bernardes", "Brazilian singer, songwriter, composer, and producer."],
  ["Bad Bunny", "Puerto Rican singer, rapper, and songwriter."],
  [
    "Nelly Furtado",
    "Canadian singer and songwriter known for genre-spanning pop.",
  ],
  [
    "Becky G",
    "American singer and actress working across Latin and pop music.",
  ],
  ["Dua Lipa", "English and Albanian pop singer and songwriter."],
  ["Charli xcx", "English singer and songwriter known for experimental pop."],
  [
    "GP DA ZL",
    "Brazilian artist and producer associated with funk and independent rap.",
  ],
  ["Jhow MC", "Brazilian MC and collaborator."],
  ["Mc Makauli", "Brazilian MC and collaborator."],
  ["Sabrina Carpenter", "American pop singer, songwriter, and actress."],
  ["Pitty", "Brazilian rock singer, songwriter, and musician."],
  ["Qveen Herby", "American rapper, singer, songwriter, and visual artist."],
  [
    "Chappell Roan",
    "American singer and songwriter known for theatrical queer pop.",
  ],
  ["The Warning", "Mexican rock trio formed by the Villarreal Vélez sisters."],
  ["Zara Larsson", "Swedish pop singer and songwriter."],
  [
    "Dupê",
    "Independent Brazilian artist blending rap with regional and alternative sounds.",
  ],
  [
    "Margaret Qualley",
    "American actress and performer starring in The Substance.",
  ],
  ["Demi Moore", "American actress and producer starring in The Substance."],
  ["Dennis Quaid", "American actor appearing in The Substance."],
] as const;

async function run(command: string[], captureOutput = false): Promise<string> {
  const child = Bun.spawn(command, {
    cwd: process.cwd(),
    stdout: captureOutput ? "pipe" : "inherit",
    stderr: "inherit",
  });
  const output = captureOutput ? await new Response(child.stdout).text() : "";
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${command[0]} exited with status ${exitCode}`);
  }
  return output;
}

async function probeVideo(filePath: string) {
  const output = await run(
    [
      "ffprobe",
      "-v",
      "error",
      "-show_entries",
      "format=duration,bit_rate:stream=codec_type,codec_name,width,height,r_frame_rate",
      "-of",
      "json",
      filePath,
    ],
    true,
  );
  const probe = JSON.parse(output);
  const videoStream = probe.streams.find(
    (stream: any) => stream.codec_type === "video",
  );
  const audioStream = probe.streams.find(
    (stream: any) => stream.codec_type === "audio",
  );
  const [fpsNumerator, fpsDenominator] = String(
    videoStream?.r_frame_rate || "0/1",
  )
    .split("/")
    .map(Number);

  return {
    durationSeconds: Number(probe.format.duration || 0),
    width: Number(videoStream?.width || 0),
    height: Number(videoStream?.height || 0),
    codec: videoStream?.codec_name || null,
    bitrate: Number(probe.format.bit_rate || 0) || null,
    fps: fpsDenominator ? fpsNumerator / fpsDenominator : null,
    audioCodec: audioStream?.codec_name || null,
  };
}

async function getBestAvailableHeight(youtubeId: string): Promise<number> {
  const output = await run(
    [
      "yt-dlp",
      "--no-playlist",
      "--skip-download",
      "-f",
      HD_FORMAT,
      "--print",
      "%(height)s",
      `https://www.youtube.com/watch?v=${youtubeId}`,
    ],
    true,
  );
  const heights = output
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter(Number.isFinite);
  return heights.length > 0 ? Math.max(...heights) : 0;
}

function createCreator(name: string, description: string) {
  return {
    name,
    description,
    profilePicturePath: null,
    mainPicturePath: null,
    faceThumbnailPath: null,
    aliases: [],
    platforms: [],
    socialLinks: [],
    galleryMedia: [],
    faceEmbeddings: [],
  };
}

function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function youtubeSearchUrl(name: string): string {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(`${name} official`)}`;
}

function wikipediaSearchUrl(name: string): string {
  return `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(name)}`;
}

function formatVttTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const millis = Math.round((seconds % 1) * 1000);
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}.${millis.toString().padStart(3, "0")}`;
}

async function ensureImageVariant(
  inputPath: string,
  outputPath: string,
  filter: string,
) {
  if (existsSync(outputPath)) {
    return;
  }

  await run([
    "ffmpeg",
    "-v",
    "error",
    "-n",
    "-i",
    inputPath,
    "-frames:v",
    "1",
    "-vf",
    filter,
    "-q:v",
    "3",
    outputPath,
  ]);
}

async function ensureStoryboard(video: any, videoId: number) {
  const sourcePath = join(process.cwd(), video.filePath);
  const baseName = slugify(video.fileName.replace(/\.[^.]+$/, ""));
  const relativeSpritePath = `demo_mode/storyboard/${baseName}_sprite.jpg`;
  const relativeVttPath = `demo_mode/storyboard/${baseName}.vtt`;
  const spritePath = join(process.cwd(), relativeSpritePath);
  const vttPath = join(process.cwd(), relativeVttPath);
  const temporarySpritePath = join(
    process.cwd(),
    "demo_mode",
    ".downloads",
    `${baseName}_sprite.jpg`,
  );
  const intervalSeconds = Math.max(
    5,
    Math.ceil(Number(video.durationSeconds) / 40),
  );
  const tileCount = Math.ceil(Number(video.durationSeconds) / intervalSeconds);
  const cols = 8;
  const rows = Math.ceil(tileCount / cols);
  const tileWidth = 320;
  const tileHeight = 180;
  const expectedApiPath = `/api/videos/${videoId}/storyboard.jpg`;
  const existingVtt = existsSync(vttPath)
    ? await readFile(vttPath, "utf8")
    : "";

  if (!existsSync(spritePath) || !existingVtt.includes(expectedApiPath)) {
    await run([
      "ffmpeg",
      "-v",
      "error",
      "-y",
      "-i",
      sourcePath,
      "-frames:v",
      "1",
      "-vf",
      `fps=1/${intervalSeconds},scale=w=${tileWidth}:h=${tileHeight}:force_original_aspect_ratio=decrease,pad=${tileWidth}:${tileHeight}:(ow-iw)/2:(oh-ih)/2,tile=${cols}x${rows}:nb_frames=${tileCount}`,
      "-q:v",
      "4",
      temporarySpritePath,
    ]);
    await rename(temporarySpritePath, spritePath);

    let vttContent = "WEBVTT\n\n";
    for (let index = 0; index < tileCount; index++) {
      const startTime = index * intervalSeconds;
      const endTime = Math.min(
        (index + 1) * intervalSeconds,
        Number(video.durationSeconds),
      );
      const x = (index % cols) * tileWidth;
      const y = Math.floor(index / cols) * tileHeight;
      vttContent += `${formatVttTime(startTime)} --> ${formatVttTime(endTime)}\n`;
      vttContent += `${expectedApiPath}#xywh=${x},${y},${tileWidth},${tileHeight}\n\n`;
    }
    await writeFile(vttPath, vttContent, "utf8");
  }

  video.storyboard = {
    spritePath: relativeSpritePath,
    vttPath: relativeVttPath,
    tileWidth,
    tileHeight,
    tileCount,
    intervalSeconds,
  };
}

function addChildTagsToVideo(video: any) {
  const additions = new Set<string>();
  const has = (name: string) => video.tags.includes(name);

  if (has("Music Video")) additions.add("Official Music Video");
  if (has("Live Music")) additions.add("Live Session");
  if (has("Concert")) additions.add("Intimate Concert");
  if (
    video.studios.some((studio: string) =>
      ["NPR Music", "Tiny Desk Brasil"].includes(studio),
    )
  ) {
    additions.add("Tiny Desk");
  }
  if (has("Pop")) additions.add("Pop Performance");
  if (has("Rock")) additions.add("Alternative Rock");
  if (has("Brazilian")) additions.add("Brazilian Music");
  if (video.creators.includes("GP DA ZL")) additions.add("Brazilian Funk");
  if (has("Hip-Hop")) additions.add("Rap Performance");
  if (has("Trailer")) additions.add("Official Trailer");
  if (has("Horror")) {
    additions.add(
      video.title.includes("Substance")
        ? "Body Horror"
        : "Psychological Horror",
    );
  }
  if (has("Gaming")) additions.add("Game Cinematic");
  if (has("Fantasy")) additions.add("Epic Fantasy");
  if (has("Action")) additions.add("Combat");
  if (has("Sci-Fi")) additions.add("Future Worlds");
  if (has("Comedy")) additions.add("Satire & Humor");
  if (has("Acoustic")) additions.add("Acoustic Session");
  if (has("Internet")) additions.add("Internet Remix");
  if (has("Animation")) additions.add("Animated Short");
  if (has("Space")) additions.add("Space Adventure");

  video.tags = [...new Set([...video.tags, ...additions])];
}

async function main() {
  const demoRoot = join(process.cwd(), "demo_mode");
  const videoDir = join(demoRoot, "video");
  const thumbnailDir = join(demoRoot, "thumbnail");
  const downloadDir = join(demoRoot, ".downloads");
  const creatorDir = join(demoRoot, "creator");
  const creatorGalleryDir = join(creatorDir, "gallery");
  const studioDir = join(demoRoot, "studio");
  const storyboardDir = join(demoRoot, "storyboard");
  const jsonPath = join(demoRoot, "demo_mode.json");
  await mkdir(videoDir, { recursive: true });
  await mkdir(thumbnailDir, { recursive: true });
  await mkdir(downloadDir, { recursive: true });
  await mkdir(creatorGalleryDir, { recursive: true });
  await mkdir(studioDir, { recursive: true });
  await mkdir(storyboardDir, { recursive: true });

  const data = JSON.parse(await readFile(jsonPath, "utf8"));
  for (const [name, description, color] of EXTRA_TAGS) {
    if (!data.tags.some((tag: any) => tag.name === name)) {
      data.tags.push({ name, parentName: null, description, color });
    }
  }
  for (const [name, parentName, description, color] of CHILD_TAGS) {
    if (!data.tags.some((tag: any) => tag.name === name)) {
      data.tags.push({ name, parentName, description, color });
    }
  }
  for (const [name, description] of EXTRA_STUDIOS) {
    if (!data.studios.some((studio: any) => studio.name === name)) {
      data.studios.push({
        name,
        description,
        profilePicturePath: null,
        socialLinks: [],
      });
    }
  }
  for (const [name, description] of EXTRA_CREATORS) {
    if (!data.creators.some((creator: any) => creator.name === name)) {
      data.creators.push(createCreator(name, description));
    }
  }

  for (const [index, entry] of DOWNLOADS.entries()) {
    const relativeVideoPath = `demo_mode/video/${entry.id}.webm`;
    const videoPath = join(process.cwd(), relativeVideoPath);
    const downloadedThumbnailPath = join(videoDir, `${entry.id}.jpg`);
    const thumbnailPath = join(thumbnailDir, `${entry.id}.jpg`);
    const temporaryVideoPath = join(downloadDir, `${entry.id}.webm`);
    const temporaryThumbnailPath = join(downloadDir, `${entry.id}.jpg`);
    const existingVideo = (data.videos || []).find(
      (video: any) => video.filePath === relativeVideoPath,
    );
    let currentProbe = existsSync(videoPath)
      ? await probeVideo(videoPath)
      : null;
    let bestAvailableHeight = 0;

    if (!currentProbe || currentProbe.height < 1080) {
      try {
        bestAvailableHeight = await getBestAvailableHeight(entry.id);
      } catch (error) {
        console.warn(`Could not probe HD formats for ${entry.id}`, error);
      }
    }

    const needsDownload =
      !currentProbe ||
      (bestAvailableHeight > 0 &&
        bestAvailableHeight > (currentProbe.height || 0));
    let mediaChanged = false;

    if (needsDownload) {
      try {
        await run([
          "yt-dlp",
          "--no-playlist",
          "--force-overwrites",
          "--write-thumbnail",
          "--convert-thumbnails",
          "jpg",
          "-f",
          HD_FORMAT,
          "-o",
          `demo_mode/.downloads/${entry.id}.%(ext)s`,
          `https://www.youtube.com/watch?v=${entry.id}`,
        ]);
      } catch (error) {
        console.warn(`VP9 download failed for ${entry.id}; trying AV1`, error);
        if (!existsSync(temporaryVideoPath)) {
          try {
            await run([
              "yt-dlp",
              "--no-playlist",
              "--force-overwrites",
              "--write-thumbnail",
              "--convert-thumbnails",
              "jpg",
              "-f",
              AV1_HD_FALLBACK,
              "--merge-output-format",
              "webm",
              "-o",
              `demo_mode/.downloads/${entry.id}.%(ext)s`,
              `https://www.youtube.com/watch?v=${entry.id}`,
            ]);
          } catch (fallbackError) {
            console.warn(
              `Could not download or upgrade ${entry.id}`,
              fallbackError,
            );
          }
        }
      }

      if (existsSync(temporaryVideoPath)) {
        await rename(temporaryVideoPath, videoPath);
        if (existsSync(temporaryThumbnailPath)) {
          await rename(temporaryThumbnailPath, thumbnailPath);
        }
        currentProbe = await probeVideo(videoPath);
        mediaChanged = true;
      }
    }

    if (!existsSync(videoPath)) {
      console.warn(`Skipping trailer without a downloaded video: ${entry.id}`);
      continue;
    }

    if (existsSync(downloadedThumbnailPath) && !existsSync(thumbnailPath)) {
      await rename(downloadedThumbnailPath, thumbnailPath);
    }

    if (existingVideo && !mediaChanged) {
      continue;
    }

    const fileStats = await stat(videoPath);
    const probe = currentProbe || (await probeVideo(videoPath));
    const fileHash = new Bun.CryptoHasher("md5")
      .update(await Bun.file(videoPath).arrayBuffer())
      .digest("hex");
    const thumbnail = existsSync(thumbnailPath)
      ? {
          filePath: `demo_mode/thumbnail/${entry.id}.jpg`,
          timestampSeconds: Math.max(1, probe.durationSeconds * 0.25),
          width: 480,
          height: 360,
        }
      : null;

    if (existingVideo) {
      Object.assign(existingVideo, {
        fileSizeBytes: fileStats.size,
        fileHash,
        ...probe,
        thumbnail,
      });
      continue;
    }

    data.videos.push({
      fileName: `${entry.id}.webm`,
      filePath: relativeVideoPath,
      fileSizeBytes: fileStats.size,
      fileHash,
      ...probe,
      title: entry.title,
      description: entry.description,
      themes: entry.themes,
      creators: entry.creators,
      studios: entry.studios,
      tags: entry.tags,
      thumbnail,
      storyboard: null,
      ratings: [
        {
          rating: 4 + (index % 2),
          comment: `Demo rating for ${entry.title}.`,
        },
      ],
      bookmarks:
        probe.durationSeconds > 30
          ? [
              {
                timestampSeconds: Math.round(probe.durationSeconds / 2),
                name: "Midpoint",
                description: "A seeded bookmark for demo interaction testing.",
              },
            ]
          : [],
      stats: {
        playCount: index * 3,
        totalWatchSeconds: Math.round(probe.durationSeconds * (index + 1)),
        lastPositionSeconds:
          index % 4 === 0 ? 0 : Math.round(probe.durationSeconds * 0.35),
      },
    });
  }

  for (const video of data.videos) {
    addChildTagsToVideo(video);
  }

  for (const [videoIndex, video] of data.videos.entries()) {
    await ensureStoryboard(video, videoIndex + 1);
  }

  for (const creator of data.creators) {
    const linkedVideo =
      data.videos.find((video: any) => video.creators.includes(creator.name)) ||
      data.videos[0];
    const creatorSlug = slugify(creator.name);
    const thumbnailPath = join(process.cwd(), linkedVideo.thumbnail.filePath);
    const spritePath = join(process.cwd(), linkedVideo.storyboard.spritePath);

    if (!creator.profilePicturePath) {
      creator.profilePicturePath = `demo_mode/creator/${creatorSlug}_profile.jpg`;
      await ensureImageVariant(
        thumbnailPath,
        join(process.cwd(), creator.profilePicturePath),
        "scale=512:512:force_original_aspect_ratio=increase,crop=512:512",
      );
    }

    if (!creator.mainPicturePath) {
      creator.mainPicturePath = `demo_mode/creator/${creatorSlug}_main.jpg`;
      await ensureImageVariant(
        thumbnailPath,
        join(process.cwd(), creator.mainPicturePath),
        "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720",
      );
    }

    creator.faceThumbnailPath ||= creator.profilePicturePath;
    creator.platforms ||= [];
    creator.socialLinks ||= [];
    creator.galleryMedia ||= [];

    if (creator.platforms.length === 0) {
      creator.platforms.push({
        platformName: "YouTube",
        username: creator.name,
        profileUrl: youtubeSearchUrl(creator.name),
        isPrimary: true,
      });
    }

    if (creator.socialLinks.length === 0) {
      creator.socialLinks.push(
        {
          platformName: "YouTube",
          url: youtubeSearchUrl(creator.name),
        },
        {
          platformName: "Wikipedia",
          url: wikipediaSearchUrl(creator.name),
        },
      );
    }

    for (
      let galleryIndex = creator.galleryMedia.length;
      galleryIndex < 2;
      galleryIndex++
    ) {
      const tileIndex = Math.min(
        linkedVideo.storyboard.tileCount - 1,
        5 + galleryIndex * 9,
      );
      const x = (tileIndex % 8) * linkedVideo.storyboard.tileWidth;
      const y = Math.floor(tileIndex / 8) * linkedVideo.storyboard.tileHeight;
      const galleryPath = `demo_mode/creator/gallery/${creatorSlug}_gallery_${galleryIndex + 1}.jpg`;
      await ensureImageVariant(
        spritePath,
        join(process.cwd(), galleryPath),
        `crop=${linkedVideo.storyboard.tileWidth}:${linkedVideo.storyboard.tileHeight}:${x}:${y},scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2`,
      );
      creator.galleryMedia.push({
        label: `Demo still ${galleryIndex + 1}`,
        description: `Curated artwork from ${linkedVideo.title}.`,
        filePath: galleryPath,
      });
    }
  }

  for (const studio of data.studios) {
    const linkedVideo =
      data.videos.find((video: any) => video.studios.includes(studio.name)) ||
      data.videos[0];
    const studioSlug = slugify(studio.name);
    const thumbnailPath = join(process.cwd(), linkedVideo.thumbnail.filePath);

    if (!studio.profilePicturePath) {
      studio.profilePicturePath = `demo_mode/studio/${studioSlug}.jpg`;
      await ensureImageVariant(
        thumbnailPath,
        join(process.cwd(), studio.profilePicturePath),
        "scale=512:512:force_original_aspect_ratio=increase,crop=512:512",
      );
    }

    studio.socialLinks ||= [];
    if (studio.socialLinks.length === 0) {
      studio.socialLinks.push(
        {
          platformName: "YouTube",
          url: youtubeSearchUrl(studio.name),
        },
        {
          platformName: "Wikipedia",
          url: wikipediaSearchUrl(studio.name),
        },
      );
    }
  }

  await writeFile(jsonPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  console.log(
    `Demo library now contains ${data.videos.length} videos, ${data.creators.length} creators, ${data.studios.length} studios, and ${data.tags.length} tags.`,
  );
}

await main();
