/*
 * Greets the world. The whole point of this file is to give
 * meander something small to annotate — notice how this block
 * comment becomes a prose card on the generated page, paired
 * with the code below.
 */
export function greet(name: string): string {
  return `Hello, ${name}!`
}

/*
 * A second annotation. Each comment pairs with the code that
 * follows it, up to the next comment. That pairing is what
 * drives the split layout on the rendered page.
 */
export function shout(text: string): string {
  return text.toUpperCase() + '!'
}
