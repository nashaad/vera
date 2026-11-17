# Browser annotation

## Select or draw

Open a session and a page in the desktop's Browser pane. The pointer button at
the right of the address bar opens the annotation toolbar on the page. It works
on sites and Vera's annex pages. In Files, open an HTML file and choose Preview;
the pointer beside the preview opens the same toolbar.

Select element outlines the element under the pointer. Click to keep that
selection. Use Pen for freehand marks, Shapes for a line, arrow, rectangle,
ellipse or numbered step, and Text for a label. Color and line width apply
to the next mark. Undo, Redo and Clear affect the marks.

Add to chat puts the selection or drawing into the open session's composer.
It captures the selected element with its marks, or the visible page when no
element is selected. The toolbar and selection outline are not in the image.
The tools and selected outline remain so you can add another capture. Select a
different element to replace the selection. Close or Escape removes the toolbar
and marks; captures already added stay in the composer.

## Include with a message

A selection shows as a chip with a pointer, the element's tag and a text
excerpt. Hover or focus it to see the screenshot, Element and Text. Show more details opens
Computed styles, HTML and Siblings; Show more opens the longer HTML and sibling
excerpts. Removing the chip removes both its image and selection text.

Send your message as usual. Vera receives the screenshot as an image and a
plain-text block naming the page and describing the selection. There is no
separate annotation request. Drawings without an element include the page
address and screenshot, without element details. A local preview also names the
source file.

## Execution

The tool is the included desktop extension `vera.browser-annotate`. It is always
on and not listed in Customize. Its page script runs only after the pointer
button is pressed, in an isolated world of the page. It has no Node or file
access. The app captures the pixels and writes the image through the pasted-image
path under the current home. No background task process is started.

Navigation, closing the page or closing the window ends the tool. A capture
that cannot be read says `The page could not be read.` and attaches nothing.
The terminal and web clients have no page annotation toolbar; sent messages use
the same host prompt and image attachment requests as their other messages.
