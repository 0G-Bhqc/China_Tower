import type { PavilionId } from '../createPavilionGalleryModel';

export type PavilionWork = {
  title: string;
  author: string;
  dynasty: string;
  excerpt: string;
  gloss: string;
  appreciation: string;
  source: string;
};

export type PavilionContent = {
  id: PavilionId;
  historicalSummary: string;
  architecturalSummary: string;
  sceneCue: string;
  works: [PavilionWork, PavilionWork];
  sources: string[];
};

export const PAVILION_CONTENT: Record<PavilionId, PavilionContent> = {
  yueyang: {
    id: 'yueyang',
    historicalSummary: '岳阳楼临洞庭湖而立，历代屡有修建。今天所见楼阁以明清以来的形制和近现代修缮为基础，真正重要的并非追逐一座“原样复刻”的楼，而是它长期作为观湖、登临和寄托忧乐之地的文化位置。',
    architecturalSummary: '三层楼身立于城台之上，盔顶、回廊和层层出檐共同形成轻盈的临水轮廓。视线从石阶进入楼身，再由檐下敞廊推向洞庭湖，建筑的开合关系本身就是一条由近及远的阅读路径。',
    sceneCue: '从石阶的阴影出发，把视线交给洞庭湖的开阔水面。',
    works: [
      {
        title: '岳阳楼记',
        author: '范仲淹',
        dynasty: '北宋',
        excerpt: '庆历四年春，滕子京谪守巴陵郡。越明年，政通人和，百废具兴。乃重修岳阳楼，增其旧制，刻唐贤今人诗赋于其上。',
        gloss: '文章从重修楼阁写起，把登楼所见的阴晴变化推进到“先天下之忧而忧，后天下之乐而乐”的胸襟。',
        appreciation: '这里的楼不是孤立的名胜，而是观察天下、安顿心志的高处。页面的镜头从台基仰视檐下，再抬向湖面，正好对应文章由具体景物转入公共理想的纵深。',
        source: '《范文正公集》；岳阳市地方志与岳阳楼景区公开资料。',
      },
      {
        title: '登岳阳楼',
        author: '杜甫',
        dynasty: '唐',
        excerpt: '昔闻洞庭水，今上岳阳楼。吴楚东南坼，乾坤日夜浮。亲朋无一字，老病有孤舟。戎马关山北，凭轩涕泗流。',
        gloss: '洞庭湖的辽阔既打开天地，也反衬诗人自身的孤独与忧患。',
        appreciation: '旋转视角时，湖面并不只是背景：它把楼阁的尺度推向天地之间，也让“凭轩”这一动作有了身体感。楼台越高，个人处境与时代风云越显得相连。',
        source: '《全唐诗》；中华经典古籍库通行本。',
      },
    ],
    sources: [
      '岳阳市人民政府：岳阳楼建筑与景区资料',
      '《范文正公集》《全唐诗》相关篇目',
    ],
  },
  huanghe: {
    id: 'huanghe',
    historicalSummary: '黄鹤楼位于武汉蛇山，历代兴废与重建不断。它在文学中常常不是一座静止的建筑，而是送别、登临和远望长江的出发点；诗人借楼望江，也借江水把个人行旅放进更大的时间和空间。',
    architecturalSummary: '五层重檐、层层收分的楼身和高耸的攒尖顶构成垂直节奏。朱红木构与深色瓦面形成清晰的明暗骨架，檐口一层层向外展开，使登楼体验从城市台地逐步转向江天远景。',
    sceneCue: '让檐口的重复节奏通向长江，把送别的方向留在远景。',
    works: [
      {
        title: '黄鹤楼',
        author: '崔颢',
        dynasty: '唐',
        excerpt: '昔人已乘黄鹤去，此地空余黄鹤楼。黄鹤一去不复返，白云千载空悠悠。晴川历历汉阳树，芳草萋萋鹦鹉洲。日暮乡关何处是？烟波江上使人愁。',
        gloss: '诗从传说和空楼写起，最后落到日暮江烟中的乡愁，时间感与空间感同时展开。',
        appreciation: '楼阁的层层重檐提供了“向上”的节奏，而诗中真正牵引人的却是向远处展开的江天。浏览时保留楼身清晰的结构，让背景低调退后，正是为了让乡关之思落在远望的方向上。',
        source: '《全唐诗》；湖北省文化和旅游厅公开黄鹤楼资料。',
      },
      {
        title: '黄鹤楼送孟浩然之广陵',
        author: '李白',
        dynasty: '唐',
        excerpt: '故人西辞黄鹤楼，烟花三月下扬州。孤帆远影碧空尽，唯见长江天际流。',
        gloss: '送别没有停在楼上，而是随着一叶孤帆沿江水远去，直到消失在天际。',
        appreciation: '这一篇适合与远景水面一起阅读：建筑是送别发生的地点，江面则承接了目送的动作。拖拽模型时，檐角和江天的关系比一块说明牌更能说明诗的空间。',
        source: '《全唐诗》；中华经典古籍库通行本。',
      },
    ],
    sources: [
      '湖北省文化和旅游厅：黄鹤楼历史与建筑资料',
      '《全唐诗》相关篇目',
    ],
  },
  tengwang: {
    id: 'tengwang',
    historicalSummary: '滕王阁位于南昌赣江之滨，因王勃《滕王阁序》而成为中国文学史上最具辨识度的楼阁意象之一。历代建筑屡经兴废，现存形制属于当代重建与持续修缮的文化场所，文学记忆则跨越了具体建筑的更替。',
    architecturalSummary: '高台托起主阁和翼部，重檐、回廊与横向展开的台基构成强烈的层次。它不像单纯的高塔那样只强调向上，而是让登台、凭栏、临江和宴集等动作在多个水平面上发生。',
    sceneCue: '从高台边缘看赣江，让横向展开的楼阁和落日晚照共同进入画面。',
    works: [
      {
        title: '滕王阁序',
        author: '王勃',
        dynasty: '唐',
        excerpt: '时维九月，序属三秋。潦水尽而寒潭清，烟光凝而暮山紫。俨骖騑于上路，访风景于崇阿。',
        gloss: '九月秋景、清潭、暮山和登临路径共同构成序文的入场；景物不是背景，而是宴集与才情展开的秩序。',
        appreciation: '滕王阁的重点在“入场”：先经过台基，再穿过檐廊，最后从高处见江。镜头以较低的水平线保留台阶和平台，让建筑的空间顺序对应序文由行旅进入宴集、由秋景进入人事的节奏。',
        source: '《王子安集》；南昌市人民政府公开滕王阁资料。',
      },
      {
        title: '滕王阁诗',
        author: '王勃',
        dynasty: '唐',
        excerpt: '滕王高阁临江渚，佩玉鸣鸾罢歌舞。画栋朝飞南浦云，珠帘暮卷西山雨。闲云潭影日悠悠，物换星移几度秋。阁中帝子今何在？槛外长江空自流。',
        gloss: '诗把朝云、暮雨、闲云和长江并置，最后以流水写出人事更替与楼阁长存的张力。',
        appreciation: '平台移动镜头时，圆形闪烁会破坏这种连续的临江观看，因此底座必须先稳定下来。修复后，观者才能把注意力从“画面是否抖动”转回檐影、江流和时间感。',
        source: '《王子安集》；《全唐诗》相关篇目。',
      },
    ],
    sources: [
      '南昌市人民政府：滕王阁现状资料',
      '《王子安集》《全唐诗》相关篇目',
    ],
  },
};

export function getPavilionContent(id: PavilionId): PavilionContent {
  return PAVILION_CONTENT[id];
}
