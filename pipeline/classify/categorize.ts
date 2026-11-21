import { type ArticleCategory } from '../../shared/constants';
import { CATEGORY_VERSION } from '../config';

export type CategoryMethod = 'feed_section' | 'feed_category' | 'keyword' | 'default';

export interface Categorization {
  category: ArticleCategory;
  method: CategoryMethod;
  version: number;
}

// Section labels in the source registry that map directly to a category.
const SECTION_MAP: Record<string, ArticleCategory> = {
  politics: 'politics',
  business: 'business',
  economy: 'business',
  markets: 'business',
  technology: 'technology',
  tech: 'technology',
  science: 'science',
  health: 'health',
  entertainment: 'entertainment',
  culture: 'entertainment',
  arts: 'entertainment',
  sports: 'sports',
  sport: 'sports',
  environment: 'environment',
  climate: 'environment',
};

export function sectionToCategory(section: string | null | undefined): ArticleCategory | null {
  if (!section) return null;
  return SECTION_MAP[section.trim().toLowerCase()] ?? null;
}

type Scored = Exclude<ArticleCategory, 'other'>;

const EN_KEYWORDS: Record<Scored, string[]> = {
  politics: [
    'election', 'elections', 'senate', 'congress', 'parliament', 'president', 'presidential', 'prime minister',
    'minister', 'ministers', 'white house', 'downing street', 'democrats', 'republicans', 'labour', 'tories',
    'conservatives', 'government', 'legislation', 'lawmakers', 'mps', 'mp', 'governor', 'campaign', 'ballot',
    'vote', 'voters', 'supreme court', 'cabinet', 'diplomat', 'sanctions', 'treaty', 'chancellor', 'budget',
    'immigration', 'policy', 'referendum', 'ambassador', 'impeachment',
  ],
  business: [
    'stocks', 'shares', 'market', 'markets', 'inflation', 'interest rates', 'fed', 'federal reserve',
    'bank of england', 'economy', 'economic', 'earnings', 'profit', 'profits', 'revenue', 'merger', 'acquisition',
    'ipo', 'investors', 'tariff', 'tariffs', 'trade', 'recession', 'gdp', 'layoffs', 'jobs report', 'bankruptcy',
    'ceo', 'retailer', 'retail', 'oil prices', 'wall street', 'ftse', 'nasdaq', 'dow',
  ],
  technology: [
    'ai', 'artificial intelligence', 'chatbot', 'openai', 'google', 'apple', 'microsoft', 'meta', 'amazon',
    'software', 'app', 'apps', 'smartphone', 'iphone', 'android', 'chip', 'chips', 'semiconductor', 'nvidia',
    'cyberattack', 'cybersecurity', 'hackers', 'hack', 'data breach', 'startup', 'robot', 'robots', 'tesla',
    'social media', 'tiktok', 'algorithm', 'cloud', 'quantum',
  ],
  science: [
    'scientists', 'researchers', 'study finds', 'nasa', 'space', 'spacecraft', 'telescope', 'asteroid', 'mars',
    'moon', 'physics', 'fossil', 'dinosaur', 'species', 'genome', 'archaeologists', 'astronomers', 'experiment',
    'nobel prize', 'rocket', 'spacex', 'orbit',
  ],
  health: [
    'health', 'nhs', 'hospital', 'hospitals', 'doctors', 'nurses', 'patients', 'vaccine', 'vaccines', 'virus',
    'outbreak', 'cancer', 'disease', 'covid', 'flu', 'measles', 'drug', 'drugs', 'fda', 'medical', 'medicine',
    'mental health', 'dementia', 'obesity', 'surgery', 'pandemic', 'cdc',
  ],
  entertainment: [
    'film', 'movie', 'movies', 'actor', 'actress', 'singer', 'album', 'concert', 'festival', 'oscars', 'grammy',
    'grammys', 'emmy', 'emmys', 'netflix', 'disney', 'hollywood', 'tv', 'television', 'celebrity', 'box office',
    'bafta', 'series', 'streaming', 'pop star', 'musical', 'theatre', 'theater', 'novel',
  ],
  sports: [
    'football', 'soccer', 'nfl', 'nba', 'mlb', 'nhl', 'premier league', 'champions league', 'world cup', 'olympics',
    'olympic', 'cricket', 'rugby', 'tennis', 'golf', 'f1', 'formula 1', 'grand prix', 'quarterback', 'coach',
    'manager', 'striker', 'goal', 'goals', 'match', 'tournament', 'championship', 'playoffs', 'wimbledon',
    'transfer', 'boxing', 'ufc',
  ],
  environment: [
    'climate', 'climate change', 'global warming', 'emissions', 'carbon', 'net zero', 'wildfire', 'wildfires',
    'drought', 'flooding', 'floods', 'pollution', 'biodiversity', 'deforestation', 'renewable', 'solar', 'wind farm',
    'cop', 'conservation', 'endangered', 'heatwave', 'sea level', 'fossil fuels',
  ],
};

const JA_KEYWORDS: Record<Scored, string[]> = {
  politics: ['首相', '国会', '選挙', '政府', '与党', '野党', '自民', '立憲', '内閣', '大統領', '外相', '閣僚', '知事', '衆院', '参院', '総裁', '外交', '防衛', '法案'],
  business: ['株価', '日経平均', '円安', '円高', '日銀', '経済', '企業', '決算', '金利', '為替', '賃上げ', '物価', '景気', '関税', '上場', '買収', '倒産', '市場'],
  technology: ['ai', '人工知能', '半導体', 'スマホ', 'アプリ', 'ロボット', 'サイバー', '生成', 'ソフト', '通信', '量子', 'データ', 'ネット', 'デジタル'],
  science: ['研究', '宇宙', '科学', 'ノーベル', '探査', '衛星', 'ロケット', '化石', '天文', '実験', '発見'],
  health: ['医療', '感染', 'ワクチン', '病院', 'がん', '患者', '健康', '厚労省', 'インフル', 'コロナ', '治療', '認知症', '介護'],
  entertainment: ['映画', '俳優', '女優', 'ドラマ', '音楽', 'アニメ', '芸能', '歌手', '漫画', '紅白', '舞台', 'アイドル', '声優'],
  sports: ['野球', 'サッカー', '五輪', '大谷', '相撲', '選手', '優勝', '監督', 'リーグ', '試合', 'ゴルフ', 'テニス', 'マラソン', '甲子園', 'ラグビー', '代表'],
  environment: ['気候', '温暖化', '環境', '脱炭素', '再生可能', '原発', '排出', '生態系', '絶滅', '汚染', '猛暑'],
};

const ORDER = Object.keys(EN_KEYWORDS) as Scored[];

function scoreEnglish(text: string): Map<ArticleCategory, number> {
  const padded = ` ${text} `;
  const scores = new Map<ArticleCategory, number>();
  for (const cat of ORDER) {
    let n = 0;
    for (const kw of EN_KEYWORDS[cat]) {
      if (padded.includes(` ${kw} `)) n += kw.includes(' ') ? 2 : 1;
    }
    if (n > 0) scores.set(cat, n);
  }
  return scores;
}

function scoreJapanese(text: string): Map<ArticleCategory, number> {
  const scores = new Map<ArticleCategory, number>();
  for (const cat of ORDER) {
    let n = 0;
    for (const kw of JA_KEYWORDS[cat]) {
      if (text.includes(kw)) n += 1;
    }
    if (n > 0) scores.set(cat, n);
  }
  return scores;
}

function best(scores: Map<ArticleCategory, number>): ArticleCategory | null {
  let top: ArticleCategory | null = null;
  let topScore = 0;
  let tie = false;
  for (const [cat, score] of scores) {
    if (score > topScore) {
      top = cat;
      topScore = score;
      tie = false;
    } else if (score === topScore) {
      tie = true;
    }
  }
  // An exact tie is uncertainty, and uncertain cases are `other`.
  return tie ? null : top;
}

/**
 * Deterministic categorization. Order of evidence: the section of the feed the
 * article came from, the feed's own category labels, keyword rules on the
 * normalized headline, keyword rules on headline plus summary, and otherwise `other`.
 */
export function categorize(input: {
  headlineNormalized: string;
  summary?: string | null;
  language: string;
  defaultCategory?: string | null;
  feedCategories?: string[];
}): Categorization {
  const fromSection = sectionToCategory(input.defaultCategory);
  if (fromSection) return { category: fromSection, method: 'feed_section', version: CATEGORY_VERSION };

  for (const label of input.feedCategories ?? []) {
    const mapped = sectionToCategory(label);
    if (mapped) return { category: mapped, method: 'feed_category', version: CATEGORY_VERSION };
  }

  const score = input.language === 'ja' ? scoreJapanese : scoreEnglish;
  const fromHeadline = best(score(input.headlineNormalized));
  if (fromHeadline) return { category: fromHeadline, method: 'keyword', version: CATEGORY_VERSION };

  const summary = (input.summary ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ');
  const fromBoth = best(score(`${input.headlineNormalized} ${summary}`));
  if (fromBoth) return { category: fromBoth, method: 'keyword', version: CATEGORY_VERSION };

  return { category: 'other', method: 'default', version: CATEGORY_VERSION };
}
