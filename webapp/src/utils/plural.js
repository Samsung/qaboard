// "1 run", "3 runs", "2 reference runs". Several features have their own copy (activity/, storage/): use this one.
export const plural = (count, word, words = `${word}s`) => `${count} ${count === 1 ? word : words}`;
