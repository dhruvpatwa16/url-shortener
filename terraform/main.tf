terraform{
    required_providers {
      aws = {
        source = "hashicorp/aws"
        version = "~> 5.0"
      }
    }
}

provider "aws" {
  region = var.aws_region
  profile = "terraform-deployer"
}

resource "aws_security_group" "app_sg" {
    name = "url-shortener-sg"
    description = "Allow SSH and app traffic"

    ingress {
        description = "SSH"
        from_port = 22
        to_port = 22
        protocol = "tcp"
        cidr_blocks = ["0.0.0.0/0"]
    }

    ingress {
        description = "App port"
        from_port = 3000
        to_port = 3000
        protocol = "tcp"
        cidr_blocks = ["0.0.0.0/0"]
    }
    
    ingress {
      description = "Kubernetes API server"
      from_port   = 6443
      to_port     = 6443
      protocol    = "tcp"
      cidr_blocks = ["0.0.0.0/0"]
    }

    ingress {
      description = "Node-to-node all traffic (K8s internal)"
      from_port   = 0
      to_port     = 0
      protocol    = "-1"
      self        = true
    }

    ingress {
      description = "Kubernetes NodePort range"
      from_port   = 30000
      to_port     = 32767
      protocol    = "tcp"
      cidr_blocks = ["0.0.0.0/0"]
    }

    egress {
        from_port = 0
        to_port = 0
        protocol = "-1"
        cidr_blocks = ["0.0.0.0/0"]
    }

    tags = {
        Name = "url-shortener-sg"
    }
}

resource "aws_instance" "k8s_nodes" {
  count = 2
  ami = var.ami_id
  instance_type = var.instance_type
  key_name = var.key_name
  vpc_security_group_ids = [aws_security_group.app_sg.id]

  tags = {
    Name = count.index == 0 ? "k8s-control-plane" : "k8s-worker-1"
  }
}

resource "aws_eip" "control_plane_eip" {
  instance = aws_instance.k8s_nodes[0].id
  domain   = "vpc"

  tags = {
    Name = "k8s-control-plane-eip"
  }
}