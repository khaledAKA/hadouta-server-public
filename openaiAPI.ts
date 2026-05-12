import OpenAI from "openai";
import type { Character, Story } from "./shared/schema";
import { getCategorySystemPrompts } from "openai/openai-helper";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Predefined system messages for each category

// Age range additions
const AGE_SYSTEMS = {
  children: `TARGET AUDIENCE: Children (ages 3–8). 
    Use simple, clear vocabulary and short, easy-to-follow sentences. 
    Write with a warm, playful, and imaginative tone. 
    Include gentle humor, friendly characters, and vivid, colorful imagery. 
    Stories should carry positive moral lessons focused on kindness, friendship, family, 
    and the value of sharing and helping others.`,

  teen: `TARGET AUDIENCE: Teenagers (ages 13–17). 
    Use natural, engaging dialogue and a relatable, emotionally expressive tone. 
    Vocabulary should be varied but age-appropriate. 
    Focus on themes such as identity, friendship, self-discovery, first love, resilience, 
    and the challenges of growing up. 
    Include dynamic characters and internal conflict that reflect real teenage experiences.`,

  adult: `TARGET AUDIENCE: Adults (ages 18+). 
    Use sophisticated language, layered narrative structures, and a mature, reflective tone. 
    Explore complex themes such as relationships, personal growth, ambition, loss, and moral ambiguity. 
    Dialogue and characters should feel realistic and nuanced, 
    with emotional depth and intellectual engagement.`
};

// Language contexts
const LANGUAGE_CONTEXTS = {
  "en-us": `Use American English with casual and American slang, conversational expressions and culturally familiar references. Favor a friendly, informal tone often found in U.S. storytelling and entertainment.`,
  "en-gb": `Use British English with distinctly British vocabulary and British slang, spelling, and idiomatic expressions. Capture the tone and nuance of UK-based narratives, from witty to poetic.`,
  "en-au": `Use Australian English with local expressions and Australian slang, informal slang, and cultural references common in Australian storytelling. Maintain a relaxed, down-to-earth tone.`,
  "ar-eg": `Use Egyptian Arabic with Egyptian slang with regional dialect and expressions that reflect Egyptian culture, humor, and everyday life. Keep the tone friendly, vivid, and accessible.`,
  "ar-sa": `Use Saudi Arabic with Saudi slang with Gulf dialect nuances and culturally relevant expressions. Maintain a respectful, clear tone that aligns with traditional and modern Saudi storytelling.`,
  "es-mx": `Use Mexican Spanish with Mexican slang with local idioms, expressions, and cultural flavor. Emphasize warmth, emotion, and storytelling traditions familiar in Mexican narratives.`,
  "es-ar": `Use Argentinian Spanish with regional slang, tone, and rhythm. Reflect the expressive, passionate style common in Argentine storytelling.`,
  "fr-fr": `Use standard French with French slang with vocabulary and expressions native to France. Capture the elegance, wit, and emotional tone typical of French literature and conversation.`,
  "zh-cn": `Use Simplified Chinese with Chinese slang with references and expressions common in mainland China. Maintain a clear, culturally resonant tone suitable for a Chinese-speaking audience.`,
  "de-de": `Use standard German with German slang with expressions and idioms typical of Germany. Favor clarity, structure, and the emotional depth characteristic of German storytelling.`,
  "it-it": `Use Italian with native expressions and a passionate and Italian slang, expressive tone. Reflect the warmth, rhythm, and emotional richness of Italian storytelling tradition.`,
  "ja-jp": `Use Japanese with Japanese slang and Japanese expressions with natural expressions and cultural subtleties appropriate for Japanese audiences. Maintain a respectful and nuanced tone reflective of Japanese narrative styles.`,
  "ko-kr": `Use Korean with Korean slang with local idioms and tone suited to Korean cultural context. Balance emotional warmth with respectful storytelling dynamics.`,
  "pt-br": `Use Brazilian Portuguese with Brazilian slang with regional vocabulary, expressions, and rhythm. Capture the energetic, expressive, and heartfelt tone of Brazilian storytelling.`,
  "ru-ru": `Use Russian with Russian slang with culturally appropriate expressions and formal or poetic undertones. Emphasize emotional depth and philosophical nuance typical of Russian narratives.`,
  "hi-in": `Use Hindi with familiar Indian expressions, Indian slang, idioms, and cultural references. Maintain a warm, vibrant tone with a focus on emotion and storytelling tradition.`,
  "nl-nl": `Use Dutch with Dutch slang with expressions and vocabulary common in the Netherlands. Favor a clear, straightforward tone with touches of local humor or introspection.`,
  "sv-se": `Use Swedish with Swedish slang with native vocabulary and expressions that reflect Swedish culture and storytelling style—often calm, thoughtful, and emotionally subtle.`,
  "fi-fi": `Use Finnish with Finnish slang with native expressions and culturally relevant tone. Focus on clarity, nature-inspired themes, and a quiet emotional depth characteristic of Finnish stories.`,
  "no-no": `Use Norwegian with local vocabulary and tone appropriate for Norwegian audiences. Blend clarity with the natural, poetic rhythm of Scandinavian storytelling.`,
  "da-dk": `Use Danish with native expressions and culturally familiar references. Keep the tone relaxed, reflective, and subtly humorous.`,
  "pl-pl": `Use Polish with native vocabulary and expressions, emphasizing emotion, family, and traditional storytelling motifs found in Polish culture.`,
  "pt-pt": `Use European Portuguese with standard vocabulary and idioms. Maintain a refined tone that reflects the cadence and cultural nuances of Portugal.`,
  "es-es": `Use Castilian Spanish with standard expressions and vocabulary. Capture the richness, formality, and expressive tone typical of Spanish literature and media.`,
  "fr-ca": `Use Canadian French with regional expressions, vocabulary, and tone common in Quebec and other Francophone regions of Canada. Emphasize warmth and cultural authenticity.`,
  "th-th": `Use Thai with local expressions and cultural references. Keep the tone polite, emotional, and in line with traditional Thai storytelling values.`
};

const AGE_RANGE_IMAGE_STYLES = {
  "children": `Use a richly animated, storybook-style illustration with bright, 
    saturated colors, soft edges, and whimsical character designs. 
    Visuals should be playful, imaginative, and easily recognizable—evoking 
    warmth, curiosity, and delight. Scenes should feel magical and inviting, 
    like pages from a beloved children's picture book.`,

  "teen": `Use a stylized semi-realistic art style that blends expressive 
    animation with refined detail. Characters should have emotional range 
    and dynamic poses, with environments that balance realism and fantasy. 
    Visuals should appeal to a sense of adventure, self-discovery, and 
    growing imagination—ideal for tweens and teens.`,

  "adult": `Use a high-fidelity, photorealistic style with cinematic lighting, 
    lifelike characters, and immersive environments. Emphasize texture, 
    emotion, and visual depth to support mature storytelling. The imagery 
    should feel grounded, emotionally resonant, and capable of conveying 
    complex themes with artistic realism.`
};

// Story lengths
const STORY_LENGTHS = {
  short: { words: "your response should be more than 300 words and less than 500 words", sections: 3 },
  medium: { words: "your response should be more than 1000 words and less than 1500 words", sections: 5 },
  long: { words: "your response should be more than 2500 words and less than 4000 words", sections: 7 },
};

export async function generateStory(
  characters: Character[],
  category: string,
  ageRange: string,
  language: string,
  size: string,
  customTitle?: string,
  customDescription?: string,
  addIllustrations: boolean = false,
  originalStory?: Story | null,
): Promise<{ title: string; content: string; illustrations: string[], coverImage: string | undefined }> {
  console.log('OpenAI Story Generation Started:', { category, ageRange, language, size, charactersCount: characters.length });
  const CATEGORY_SYSTEMS = getCategorySystemPrompts(ageRange);
  const categorySystem =
    CATEGORY_SYSTEMS[category as keyof typeof CATEGORY_SYSTEMS] ||
    CATEGORY_SYSTEMS.adventure;
  const ageSystem =
    AGE_SYSTEMS[ageRange as keyof typeof AGE_SYSTEMS] || AGE_SYSTEMS.children;
  const languageContext =
    LANGUAGE_CONTEXTS[language as keyof typeof LANGUAGE_CONTEXTS] ||
    "English with appropriate cultural context";
  const lengthSpec =
    STORY_LENGTHS[size as keyof typeof STORY_LENGTHS] || STORY_LENGTHS.medium;

  const IMAGE_PLACEHOLDER = addIllustrations ?
    "CRITICAL: in the content of the story, for any language, make sure that you insert place holder for the images in english in that format (image_placeholder) for each section" : "";
  const systemMessage = `${categorySystem} ${ageSystem} LANGUAGE: Write in ${languageContext} LENGTH: ${lengthSpec.words} total in ${lengthSpec.sections} sections

Always respond with JSON: {"title": "engaging title always in ${languageContext}", "content": "full story in ${lengthSpec.sections} sections${IMAGE_PLACEHOLDER ? ", each with (image_placeholder) at the end" : ""}"
${IMAGE_PLACEHOLDER}`;

  // Safely handle character names with Unicode support
  const characterNames = characters.map((c) => {
    try {
      // Normalize Unicode characters and handle special characters
      return c.name.normalize('NFC').trim();
    } catch (error) {
      console.error('Error processing character name:', c.name, error);
      return 'Character';
    }
  }).join(", ");

  // Build user message with direct image integration and proper encoding
  const messageContent: any[] = [
    {
      type: "text",
      text: `create a story with the following details:
      characters names: ${characterNames}
      ${customTitle ? `TITLE DIRECTION: "${customTitle.normalize('NFC')}"` : ""}
      ${customDescription ? `STORY CONCEPT: "${customDescription.normalize('NFC')}"` : ""}
      CRITICAL: use the characters names in the story. and make them the heros of the story
      CRITICAL: use the story concept if provided in the story
      CRITICAL: use the STORY CONCEPT if provided in the story
      CRITICAL: don't add sections and section title at the beginning of each section`,
    },
  ];

  console.log('Calling OpenAI API for story generation...');
  console.log(systemMessage, "systemMessage");
  console.log(messageContent, "messageContent");

  let userMessageIfOriginalStory = originalStory != null ?
    `Read this story very well and make a follow up story to it with the same Language, 
  age tone, length${addIllustrations ? ", and add the same number of (image_placeholder) as the original story and always the (image_placeholder) at the end of each section in english" : ""}
  Always respond with JSON: {"title": "engaging title always in ${languageContext}", "content": "the content of the story"}` : messageContent;


  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: originalStory != null ? originalStory.content : systemMessage },
      { role: "user", content: userMessageIfOriginalStory },
    ],
    response_format: { type: "json_object" },
    max_tokens: size === "short" ? 5000 : size === "medium" ? 7000 : 10000,
    temperature: 0.8,
  });
  console.log('OpenAI story response received');

  // Safely parse OpenAI response with Unicode support
  let result;
  try {
    const content = response.choices[0].message.content || '{"title": "Story", "content": "Story content"}';
    // Normalize Unicode content before parsing
    const normalizedContent = content.normalize('NFC');
    result = JSON.parse(normalizedContent);

    // Validate and normalize the parsed result
    result.title = (result.title || "Untitled Story").normalize('NFC');
    result.content = (result.content || "Story content unavailable.").normalize('NFC');

  } catch (error) {
    console.error('Error parsing OpenAI response:', error);
    // Fallback to safe defaults
    result = {
      title: "Generated Story",
      content: "A wonderful story was created but there was an issue displaying it. Please try again."
    };
  }

  // Generate illustrations only for Ultimate tier users
  const illustrations = addIllustrations
    ? await generateIllustrations(result.content, characters, ageRange)
    : [];

  const coverImage = addIllustrations ? await generateCoverImage(result.title, result.content, ageRange) : undefined;

  return {
    title: result.title,
    content: result.content,
    illustrations,
    coverImage,
  };
}

async function generateCoverImage(
  storyTitle: string,
  storyContent: string,
  ageRange: string,
): Promise<string | undefined> {
  try {
    const artStyle =
      AGE_RANGE_IMAGE_STYLES[ageRange as keyof typeof AGE_RANGE_IMAGE_STYLES] || AGE_RANGE_IMAGE_STYLES.children;


    const prompt = `create a cover image for a story with title ${storyTitle} and content ${storyContent} in ${artStyle}
      CRITICAL: don't write anything on the generated image`;
    const response = await openai.images.generate({
      model: "gpt-image-1",
      prompt: prompt,
      n: 1,
      size: "1024x1024",
      quality: "low",
    });

    const imageBase64 = response.data?.[0]?.b64_json;
    if (imageBase64) {
      console.log("generated cover image");
    }
    return imageBase64;
  } catch (error) {
    return undefined;
  }
}




async function generateIllustrations(
  storyContent: string,
  characters: Character[],
  ageRange: string,
): Promise<string[]> {
  const illustrations: string[] = [];
  const paragraphs = storyContent.split("(image_placeholder)").filter((p) => p.trim());

  const scenes = paragraphs.map((p) => ({
    content: p,
  }));



  const artStyle =
    AGE_RANGE_IMAGE_STYLES[ageRange as keyof typeof AGE_RANGE_IMAGE_STYLES] || AGE_RANGE_IMAGE_STYLES.children;

  for (let i = 0; i < scenes.length; i++) {
    try {

      const charactersWithPhotos = characters.filter((char) => char.photo);
      let characterPrompt = "";

      if (charactersWithPhotos.length > 0) {
        characterPrompt = `Show these characters: ${charactersWithPhotos.map((c) => `${c.name}`).join(", ")}. and don't write anything on the generated image `;
      }

      const prompt = `Create a ${artStyle} depicting: "${scenes[i].content}"

${characterPrompt}`;
      console.log(prompt, "prompt");
      const response = await openai.images.generate({
        model: "gpt-image-1",
        prompt: prompt,
        n: 1,
        size: "1024x1024",
        quality: "low",
      });
      console.log(response, "response");

      const imageBase64 = response.data?.[0]?.b64_json;
      if (imageBase64) {
        illustrations.push(imageBase64);
        console.log(`Successfully generated illustration ${i + 1}`);
        console.log(imageBase64, "imageUrl");
      }
    } catch (error) {
      console.error(`Error generating illustration ${i + 1}:`, error);
    }
  }

  return illustrations;
}
