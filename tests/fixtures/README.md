`encryption-source.pdf` is a synthetic three-page PDF with text and a one-pixel image on each page. It was created with the bundled pdf-lib; page widths are 300, 301 and 302 points.

`permission-encrypted.pdf` contains the same pages encrypted with AES-128 using pypdf, an empty opening password and the synthetic owner password `fixture-owner`. These fixtures contain no user documents and let the tests reproduce pdf-lib's encryption rejection without external tools or network access.
