// https://www.npmjs.com/package/js-levenshtein
import QuickLRU from "quick-lru"
import levenshtein from "js-levenshtein"


const cache = new QuickLRU({maxSize: 8*1024})


const shorten = string => {
    return string.replace(/(workspace|[{}", '/.\-_]|global|sim|partial_config|image_writer|config|raw|bmp)/, "")
}

const memoized_levenshtein = (str1, str2) => {
    // with a separator, or e.g. ("a", "bc") and ("", "abc") would share a cache entry
    const key = str1.length < str2.length ? `${str1}\u0000${str2}` : `${str2}\u0000${str1}`
    if (cache.has(key)) {
        return cache.get(key)
    } else {
        const result = levenshtein(shorten(str1), shorten(str2))
        cache.set(key, result)
        return result
    }
}

export { memoized_levenshtein };
