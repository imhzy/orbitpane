import os
import json
with open("pm2_env.json", "w") as f:
    json.dump(dict(os.environ), f)
