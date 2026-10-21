"""PyCharm entry point. Same as running `python app.py`."""

import os

from app import app

if __name__ == "__main__":
    app.run(debug=True, port=int(os.getenv("PORT", 5050)))
