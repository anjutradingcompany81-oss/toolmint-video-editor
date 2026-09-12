# Voices

One voice = two files with the same stem:

    my-voice.wav    a clean 5-15 second recording of the speaker
    my-voice.txt    exactly what is said in that clip, in Hindi

The transcript is not optional. F5 conditions on what the reference says
as well as how it sounds, and a wrong transcript degrades the output
quietly rather than failing. A `.wav` with no `.txt` is skipped and logged.

Append `__male` or `__female` to the stem to set the gender shown in the
picker: `gajju__male.wav`.

## Recording a good reference

- 5-15 seconds. Longer is not better; F5 truncates.
- One speaker, no music, no room echo, no clipping.
- Normal speaking pace and the tone you want back.
- 24kHz or higher. Mono.

## Licensing

Clips you record yourself are yours. Do not drop in someone else's voice
without their permission - the point of this directory is that every voice
in it is one you have the right to use.
